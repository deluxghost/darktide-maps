"""Batched ray and body-slab queries against a fixed triangle set."""

import numpy as np
from numba import njit
from numba.core import types
from numba.extending import intrinsic

CELL = 2.0          # m; spatial grid of the triangle index
BLOCK = 16384       # ray x triangle pairs per block; a block's shape picks the BLAS summation order reproduced below


class Rays:
    """Triangles indexed on a 2D grid; rays are tested in batches against a candidate subset."""

    def __init__(self, tris):
        tris = np.asarray(tris, float).reshape(-1, 3, 3)
        self.t = tris
        e1 = tris[:, 1] - tris[:, 0]; e2 = tris[:, 2] - tris[:, 0]
        # plane normal and dual vectors: for p on the plane, u = p.A - cA, v = p.B - cB (barycentric)
        n = np.cross(e1, e2); nn = np.einsum("ij,ij->i", n, n); nn[nn == 0] = np.inf
        self.N = n; self.A = np.cross(e2, n) / nn[:, None]; self.B = np.cross(n, e1) / nn[:, None]
        v0 = tris[:, 0]
        self.cN = np.einsum("ij,ij->i", v0, n); self.cA = np.einsum("ij,ij->i", v0, self.A)
        self.cB = np.einsum("ij,ij->i", v0, self.B)
        lo = np.floor(tris[:, :, :2].min(1) / CELL).astype(int); hi = np.floor(tris[:, :, :2].max(1) / CELL).astype(int)
        span = hi - lo + 1; count = span[:, 0] * span[:, 1]
        tri = np.repeat(np.arange(len(tris)), count)
        k = np.arange(count.sum()) - np.repeat(np.cumsum(count) - count, count)
        cx = lo[tri, 0] + k // span[tri, 1]; cy = lo[tri, 1] + k % span[tri, 1]
        order = np.lexsort((cy, cx)); cx, cy, tri = cx[order], cy[order], tri[order]
        # cells as sorted keys (cx - x0) * height + (cy - y0), each owning tri[start[k]:start[k + 1]] in index order
        self.origin = (int(cx.min()), int(cy.min())) if len(tri) else (0, 0)
        self.size = (int(cx.max()) - self.origin[0] + 1, int(cy.max()) - self.origin[1] + 1) if len(tri) else (0, 0)
        key = (cx - self.origin[0]).astype(np.int64) * self.size[1] + (cy - self.origin[1])
        first = np.ones(len(key), bool); first[1:] = key[1:] != key[:-1]
        self.keys = key[first]; self.start = np.r_[np.nonzero(first)[0], len(key)]; self.tri = tri.astype(np.int64)
        self.zlo = tris[:, :, 2].min(1); self.zhi = tris[:, :, 2].max(1)
        self.cxy = tris[:, :, :2].mean(1); self.rad = np.linalg.norm(tris[:, :, :2] - self.cxy[:, None], axis=2).max(1)
        self.seen = np.zeros(len(tris), np.bool_)      # scratch for de-duplicating candidate lists

    def __len__(self):
        return len(self.t)

    def candidates(self, lo, hi):
        """Sorted indices of triangles whose grid cells overlap the box [lo, hi] and whose z range overlaps it."""
        return candidates_kernel(self.keys, self.start, self.tri, self.origin[0], self.origin[1], self.size[0],
                                 self.size[1], self.zlo, self.zhi, self.seen, float(lo[0]), float(lo[1]),
                                 float(lo[2]), float(hi[0]), float(hi[1]), float(hi[2]))

    def cell(self, x, y):
        """Triangles of grid cell (x, y), or None."""
        x -= self.origin[0]; y -= self.origin[1]
        if not (0 <= x < self.size[0] and 0 <= y < self.size[1]):
            return None
        k = np.searchsorted(self.keys, x * self.size[1] + y)
        if k == len(self.keys) or self.keys[k] != x * self.size[1] + y:
            return None
        return self.tri[self.start[k]:self.start[k + 1]]

    def strip(self, idx, s, nrm, length, half):
        """Of candidate triangles idx, those that can touch the strip from s along nrm (length) of half width."""
        rel = self.cxy[idx] - s[:2]; r = self.rad[idx]
        along = rel @ nrm; perp = np.abs(rel @ np.array([-nrm[1], nrm[0]]))
        return idx[(along >= -r - half) & (along <= length + r + half) & (perp <= half + r)]

    def intersect(self, o, d, tmax, idx):
        """Nearest hit distance per ray (inf if none) for rays o + d*t, t in (1e-4, tmax], against triangles idx."""
        n = len(o)
        if not len(idx) or not n:
            return np.full(n, np.inf)
        return intersect_kernel(np.ascontiguousarray(o, float), np.ascontiguousarray(d, float),
                                np.ascontiguousarray(tmax, float), np.ascontiguousarray(idx, np.int64),
                                max(1, BLOCK // len(idx)), self.N, self.A, self.B, self.cN, self.cA, self.cB)

    def cast(self, o, d, tmax):
        """First hit distance along o + d*t up to tmax, or None."""
        o = np.asarray(o, float); d = np.asarray(d, float); end = o + d * tmax
        idx = self.candidates(np.minimum(o, end), np.maximum(o, end))
        t = self.intersect(o[None], d[None], np.array([tmax]), idx)[0]
        return float(t) if np.isfinite(t) else None

    def vertical(self, points, up, length, *, surfaces=None):
        """Distance of the first hit of a vertical ray (+z if up, else -z) from each point; rays grouped per cell."""
        points = np.asarray(points, float); out = np.full(len(points), np.inf)
        if not len(points):
            return out
        d = np.array([0, 0, 1.0 if up else -1.0])
        cells = np.floor(points[:, :2] / CELL).astype(int)
        order = np.lexsort((cells[:, 1], cells[:, 0])); cs = cells[order]
        breaks = np.nonzero(np.any(np.diff(cs, axis=0) != 0, axis=1))[0] + 1
        for group in np.split(order, breaks):
            idx = self.cell(int(cells[group[0], 0]), int(cells[group[0], 1]))
            if idx is None:
                continue
            if surfaces is not None:
                idx = idx[surfaces[idx]]
            group = group[np.argsort(points[group, 2], kind="stable")]
            for chunk in np.array_split(group, len(group) // 256 + 1):
                if len(chunk):
                    z = points[chunk, 2]
                    lo, hi = (z.min(), z.max() + length) if up else (z.min() - length, z.max())
                    near = idx[(self.zhi[idx] >= lo - 1e-6) & (self.zlo[idx] <= hi + 1e-6)]
                    out[chunk] = self.intersect(points[chunk], np.broadcast_to(d, (len(chunk), 3)),
                                                np.full(len(chunk), length), near)
        return out

    def batched(self, origins, dirs, tmax, cell=CELL):
        """Nearest hit per ray, rays grouped per 3D cell of their origins (a group's box spans one floor); short rays
        go in smaller cells, so each group tests fewer triangles."""
        out = np.full(len(origins), np.inf)
        if not len(origins):
            return out
        reach = np.abs(dirs) * tmax[:, None]
        cells = np.floor(origins / cell).astype(np.int64)
        order = np.lexsort((cells[:, 2], cells[:, 1], cells[:, 0])); cs = cells[order]
        breaks = np.nonzero(np.any(np.diff(cs, axis=0) != 0, axis=1))[0] + 1
        for idx in np.split(order, breaks):
            lo = (origins[idx] - reach[idx]).min(0) - 0.05
            hi = (origins[idx] + reach[idx]).max(0) + 0.05
            out[idx] = self.intersect(origins[idx], dirs[idx], tmax[idx], self.candidates(lo, hi))
        return out


@njit(cache=True)
def candidates_kernel(keys, start, tri, x_origin, y_origin, width, height, zlo, zhi, seen, lx, ly, lz, hx, hy, hz):
    """Rays.candidates over the cell table: z-overlapping triangles of the overlapped cells, one copy each, sorted."""
    x0 = int(np.floor(lx / CELL)) - x_origin; x1 = int(np.floor(hx / CELL)) - x_origin
    y0 = int(np.floor(ly / CELL)) - y_origin; y1 = int(np.floor(hy / CELL)) - y_origin
    x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, width - 1); y1 = min(y1, height - 1)
    zl = lz - 1e-6; zh = hz + 1e-6
    total = 0; cells = 0
    for x in range(x0, x1 + 1):
        first = np.searchsorted(keys, x * height + y0); last = np.searchsorted(keys, x * height + y1, "right")
        if last > first:
            total += start[last] - start[first]; cells += last - first
    out = np.empty(total, np.int64); n = 0
    for x in range(x0, x1 + 1):
        first = np.searchsorted(keys, x * height + y0); last = np.searchsorted(keys, x * height + y1, "right")
        for k in range(start[first], start[last]):
            j = tri[k]
            if zhi[j] >= zl and zlo[j] <= zh and not seen[j]:
                seen[j] = True; out[n] = j; n += 1
    out = out[:n]
    for j in out:
        seen[j] = False
    if cells > 1:
        out.sort()
    return out


@intrinsic
def fma(typingctx, a, b, c):
    """Fused a * b + c, rounded once."""
    def codegen(context, builder, signature, args):
        return builder.fma(*args)
    return types.float64(types.float64, types.float64, types.float64), codegen


@njit(inline="always")
def dot(p, q, order):
    """p . q summed as numpy matmul does for a (rows x 3) @ (3 x triangles) block: a matrix product (order 0) fuses
    y then z onto x; a single row or column (order 1, a BLAS vector product) fuses x then z onto y; a 1 x 1 product
    (order 2) is numpy's own unfused sum."""
    if order == 0:
        return fma(p[2], q[2], fma(p[1], q[1], p[0] * q[0]))
    if order == 1:
        return fma(p[2], q[2], fma(p[0], q[0], p[1] * q[1]))
    return p[0] * q[0] + p[1] * q[1] + p[2] * q[2]


@njit(cache=True)
def intersect_kernel(o, d, tmax, idx, rows, N, A, B, cN, cA, cB):
    """Nearest hit per ray against triangles idx given by planes and barycentric duals, rays taken in blocks of rows;
    tests stop at the first failing condition, which leaves the nearest hit unchanged."""
    out = np.full(len(o), np.inf)
    for i in range(len(o)):
        block = min(rows, len(o) - i // rows * rows)
        order = 2 if block == 1 and len(idx) == 1 else 1 if block == 1 or len(idx) == 1 else 0
        oi = o[i]; di = d[i]; best = np.inf
        for j in idx:
            dn = dot(di, N[j], order)
            if not abs(dn) > 1e-12:
                continue
            t = (cN[j] - dot(oi, N[j], order)) / dn
            if not (t > 1e-4 and t <= tmax[i] and t < best):
                continue
            u = (dot(oi, A[j], order) - cA[j]) + t * dot(di, A[j], order)
            if not u >= 0:
                continue
            v = (dot(oi, B[j], order) - cB[j]) + t * dot(di, B[j], order)
            if v >= 0 and u + v <= 1:
                best = t
        out[i] = best
    return out


def body_sweep(tris, s, dir3, side, half, bands, reach, windows=None):
    """Distance along dir3 at which a body slab (|lateral| <= half, z within each band) first meets any of tris;
    inf if none within reach. The clipped triangle is convex, so its nearest point is a triangle vertex, an edge
    crossing a slab face, or a slab edge line crossing the triangle plane."""
    if not len(tris):
        return np.full(len(bands), np.inf)
    rel = tris - s
    X0 = rel @ dir3; Y0 = rel @ side; Z0 = tris[..., 2]                  # (k, 3) local coordinates
    out = []
    eps = 1e-6
    near_y = (Y0.min(1) <= half + eps) & (Y0.max(1) >= -half - eps)
    for band_index, (zlo, zhi) in enumerate(bands):
        xmin, xmax = windows[band_index] if windows else (0.05, reach)
        keep = near_y & (Z0.min(1) <= zhi + eps) & (Z0.max(1) >= zlo - eps) & (X0.max(1) >= xmin) & (X0.min(1) <= xmax)
        if not keep.any():
            out.append(np.inf)
            continue
        X, Y, Z = X0[keep], Y0[keep], Z0[keep]

        def inside(y, z):
            return (np.abs(y) <= half + eps) & (z >= zlo - eps) & (z <= zhi + eps)
        cands = [(X, inside(Y, Z))]                                    # (k, m) candidate x and validity
        with np.errstate(divide="ignore", invalid="ignore"):
            for a, b in ((0, 1), (1, 2), (2, 0)):
                xa, xb, ya, yb, za, zb = X[:, a], X[:, b], Y[:, a], Y[:, b], Z[:, a], Z[:, b]
                for va, vb, c in ((ya, yb, half), (ya, yb, -half), (za, zb, zlo), (za, zb, zhi)):
                    den = vb - va
                    t = (c - va) / den
                    ok = (np.abs(den) > eps) & (t >= -eps) & (t <= 1 + eps)
                    x = xa + (xb - xa) * t; y = ya + (yb - ya) * t; z = za + (zb - za) * t
                    cands.append((x[:, None], (ok & inside(y, z))[:, None]))
            # slab edge lines (y = +-half, z = zlo/zhi, x free) against the triangle plane
            e1 = np.stack([X[:, 1] - X[:, 0], Y[:, 1] - Y[:, 0], Z[:, 1] - Z[:, 0]], 1)
            e2 = np.stack([X[:, 2] - X[:, 0], Y[:, 2] - Y[:, 0], Z[:, 2] - Z[:, 0]], 1)
            det = e1[:, 1] * e2[:, 2] - e1[:, 2] * e2[:, 1]
            for yc in (half, -half):
                for zc in (zlo, zhi):
                    ry, rz = yc - Y[:, 0], zc - Z[:, 0]
                    u = (ry * e2[:, 2] - rz * e2[:, 1]) / det
                    v = (e1[:, 1] * rz - e1[:, 2] * ry) / det
                    ok = (np.abs(det) > eps) & (u >= -eps) & (v >= -eps) & (u + v <= 1 + eps)
                    cands.append(((X[:, 0] + u * e1[:, 0] + v * e2[:, 0])[:, None], ok[:, None]))
            xs = np.concatenate([c[0] for c in cands], 1); ok = np.concatenate([c[1] for c in cands], 1)
            hi = np.where(ok, xs, -np.inf).max(1); lo = np.where(ok, xs, np.inf).min(1)
        ahead = ok.any(1) & (hi >= xmin) & (lo <= xmax)
        hit = np.where(ahead, np.maximum(lo, xmin), np.inf)
        best = float(hit.min()) if len(hit) else np.inf
        out.append(best if best <= reach else np.inf)
    return np.array(out)
