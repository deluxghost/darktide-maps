"""Floor-restoration rules for nav carving on stairs, ramps and raised slabs.

Restore carved floor samples only when:
  - the floor is at least low - RAISED above the local nav plane;
  - it connects to nav-level floor in steps no higher than low;
  - the body band [floor + low, floor + high] intersects no surface or enclosing solid.
Tops that fail this local step connection stay carved; global player reachability is a separate stage.
"""

from collections import deque

import numpy as np
import shapely
from scipy.spatial import ConvexHull

from ..reach.rays import Rays
from .sections import convex_projection
from .world import curved_shape

CELL = 0.15
MARGIN = 1.5           # floor cells around a triangle that can connect its carved cells to Nav-level floor


HULLS = {}   # hull faces per collision shape template: placing a shape (an affine map) keeps its hull's faces


def shape_triangles(shape):
    """World-space triangles of one placed collision shape (convex shapes as the hull of their vertices)."""
    if shape.get("triangles") is not None:
        return np.asarray(shape["triangles"], float).reshape(-1, 3, 3)
    if "curve" in shape:
        vertices, _ = curved_shape(*shape["curve"])
        points = vertices @ shape["rotation"].T + shape["position"]
        key = shape["curve"]
    else:
        points = np.asarray(shape["vertices"], float)
        source = shape.get("source", {})
        key = (source.get("resource"), source.get("actor"), source.get("shape")) if "resource" in source else None
    if key is not None and key in HULLS:
        return points[HULLS[key]]
    try:
        faces = ConvexHull(points).simplices
        if key is not None:
            HULLS[key] = faces
        return points[faces]
    except Exception:            # flat or degenerate: its bounding box
        low, high = points.min(0), points.max(0)
        corners = np.array([[x, y, z] for x in (low[0], high[0]) for y in (low[1], high[1]) for z in (low[2], high[2])])
        return corners[ConvexHull(corners + np.random.default_rng(0).normal(0, 1e-6, corners.shape)).simplices]


def floor_heights(rays, xy, base, top, room, *, surfaces=None):
    """Real floor heights at plan points: going up from base (per point) to top, the first collision surface with no
    other surface within room above it, where a body stands; nan if none. Surfaces under a floor (the underside of
    a step, stacked pieces) and the undersides of overhangs have another surface close above and are passed; an
    overhang higher up (a walkway, a ceiling) is not mistaken for the floor below it."""
    xy = np.asarray(xy, float).reshape(-1, 2)
    z = np.asarray(base, float).copy()
    top = np.broadcast_to(np.asarray(top, float), z.shape)
    out = np.full(len(z), np.nan)
    active = np.arange(len(z))
    lift = 0.01
    while len(active):
        span = float((top[active] - z[active]).max())
        if span <= 0:
            break
        hit = rays.vertical(np.c_[xy[active], z[active]], True, span, surfaces=surfaces)
        surface = z[active] + hit
        found = np.isfinite(hit) & (surface <= top[active])
        active, surface = active[found], surface[found]
        if not len(active):
            break
        free = ~np.isfinite(rays.vertical(np.c_[xy[active], surface + lift], True, room))
        out[active[free]] = surface[free]
        z[active[~free]] = surface[~free] + lift
        active = active[~free]
    return out


class NavSurface:
    """Height of the Nav surface (the triangle plane under a point), for seeding Nav-level floor."""

    def __init__(self, points, triangles):
        self.tris = points[np.asarray([t[:3] for t in triangles]) - 1]
        self.polygons = shapely.polygons(self.tris[:, :, :2])
        self.tree = shapely.STRtree(self.polygons)
        self.low = self.tris[:, :, 2].min(1)
        self.high = self.tris[:, :, 2].max(1)
        normal = np.cross(self.tris[:, 1] - self.tris[:, 0], self.tris[:, 2] - self.tris[:, 0])
        self.planes = np.c_[-normal[:, :2] / normal[:, 2, None],
                            np.einsum("ij,ij->i", normal, self.tris[:, 0]) / normal[:, 2]]

    def supports_top(self, shape, step):
        """A convex prop without Nav over its upper cap is an obstacle, not a replacement floor."""
        peak = shape["high"][2]
        cap = convex_projection(shape, np.array([0., 0., 1., 0.]), peak - step, peak + step)
        low, high = peak - 2 * step + RAISED, peak + SEED_BELOW
        candidates = self.tree.query(cap, predicate="intersects")
        candidates = candidates[(self.high[candidates] >= low) & (self.low[candidates] <= high)]
        for index in candidates:
            xy = shapely.get_coordinates(cap.intersection(self.polygons[index]))
            z = xy @ self.planes[index, :2] + self.planes[index, 2]
            if len(z) and z.max() >= low and z.min() <= high:
                return True
        return False

    def heights(self, xy):
        """Per point: Nav heights of all triangles covering it (list of arrays)."""
        pts = shapely.points(xy)
        result = [[] for _ in range(len(xy))]
        point_index, tri_index = self.tree.query(pts, predicate="intersects")
        for p, t in zip(point_index, tri_index):
            a, b, c = self.tris[t]
            v0, v1, v2 = b[:2] - a[:2], c[:2] - a[:2], xy[p] - a[:2]
            d = v0[0] * v1[1] - v0[1] * v1[0]
            if abs(d) < 1e-12:
                continue
            u = (v2[0] * v1[1] - v2[1] * v1[0]) / d; w = (v0[0] * v2[1] - v0[1] * v2[0]) / d
            result[p].append(a[2] + u * (b[2] - a[2]) + w * (c[2] - a[2]))
        return result


def floor_queries(shapes, nav, step):
    """Filter floor sources without removing any collision from body-clearance queries."""
    geometry, sources = [], []
    for shape in shapes:
        if "volume" in shape["source"]:
            continue
        triangles = shape_triangles(shape)
        geometry.append(triangles)
        sources.append(np.full(len(triangles), not shape["convex"] or nav.supports_top(shape, step)))
    return Rays(np.concatenate(geometry)), np.concatenate(sources)


RAISED = 0.05          # tolerance below CLEARANCE_LOW for a floor to count as raised above the Nav plane
SEED_BELOW = 0.15      # floor this far below the Nav plane still counts as Nav-level floor


def vertical_span(tris, xy):
    """Per point: (lowest, highest) height where the vertical line through it crosses the triangles (nan if none).
    For a convex solid this is exactly the part of the line inside it."""
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    v0 = (b - a)[:, :2]; v1 = (c - a)[:, :2]
    d = v0[:, 0] * v1[:, 1] - v0[:, 1] * v1[:, 0]
    keep = np.abs(d) > 1e-12
    a, b, c, v0, v1, d = a[keep], b[keep], c[keep], v0[keep], v1[keep], d[keep]
    p = xy[:, None, :] - a[None, :, :2]
    u = (p[..., 0] * v1[:, 1] - p[..., 1] * v1[:, 0]) / d
    w = (v0[:, 0] * p[..., 1] - v0[:, 1] * p[..., 0]) / d
    inside = (u >= -1e-9) & (w >= -1e-9) & (u + w <= 1 + 1e-9)
    z = a[:, 2] + u * (b[:, 2] - a[:, 2]) + w * (c[:, 2] - a[:, 2])
    lowest = np.where(inside, z, np.inf).min(1); highest = np.where(inside, z, -np.inf).max(1)
    return np.where(np.isfinite(lowest), lowest, np.nan), np.where(np.isfinite(highest), highest, np.nan)


def enclosed(solids, xy, z):
    """Per point: some carving solid's vertical span contains the height z at that point."""
    out = np.zeros(len(xy), bool)
    for tris in solids:
        lo2, hi2 = tris[:, :, :2].min((0, 1)), tris[:, :, :2].max((0, 1))
        sel = np.nonzero(~out & (xy >= lo2).all(1) & (xy <= hi2).all(1))[0]
        if len(sel):
            bottom, top = vertical_span(tris, xy[sel])
            out[sel[(bottom < z[sel]) & (top > z[sel])]] = True
    return out


def walkable_cut(removed, plane, subject, rays, nav, low, high, solids=(), *, surfaces=None):
    """Part of the carved polygon that is really walkable floor (see module docstring); empty if none.
    solids: triangles of each closed (convex or curved) carving shape, for the enclosed-band test."""
    if removed.is_empty:
        return removed
    plane_z = lambda xy: -(plane[0] * xy[:, 0] + plane[1] * xy[:, 1] + plane[3])
    x0, y0, x1, y1 = removed.bounds
    xs = np.arange(x0 + CELL / 2, x1, CELL); ys = np.arange(y0 + CELL / 2, y1, CELL)
    gx, gy = np.meshgrid(xs, ys) if len(xs) and len(ys) else (np.zeros((0, 0)), np.zeros((0, 0)))
    cut_xy = np.c_[gx.ravel(), gy.ravel()]
    cut_xy = cut_xy[shapely.contains_xy(removed, cut_xy[:, 0], cut_xy[:, 1])]
    # parts thinner than a cell are probed by a point of their own
    probes = shapely.get_coordinates(shapely.point_on_surface(shapely.get_parts(removed)))
    cut_xy = np.concatenate([cut_xy, probes])
    if not len(cut_xy):
        return shapely.Polygon()
    zp = plane_z(cut_xy)
    floor = floor_heights(rays, cut_xy, zp - SEED_BELOW, zp + high, high, surfaces=surfaces)
    # fast path: only cells whose real floor rises into the band can be floor misjudged as an obstacle
    if not ((floor - zp >= low - RAISED) & (floor - zp <= high)).any():
        return shapely.Polygon()
    wx0, wy0, wx1, wy1 = subject.bounds
    wx = np.arange(wx0 - MARGIN, wx1 + MARGIN, CELL); wy = np.arange(wy0 - MARGIN, wy1 + MARGIN, CELL)
    gx, gy = np.meshgrid(wx, wy)
    xy = np.c_[gx.ravel(), gy.ravel()]
    ground = floor_heights(rays, xy, plane_z(xy) - SEED_BELOW, plane_z(xy) + high + 1.0, high, surfaces=surfaces)
    known = np.isfinite(ground)
    navz = nav.heights(xy)
    # Nav-level floor: floor the plane test itself does not count as raised (Nav can sit a little under a flat floor
    # for long stretches, e.g. along a track bed, so a fixed small tolerance would leave no seed at all)
    seed = np.array([known[i] and any(-SEED_BELOW <= ground[i] - z < low - RAISED for z in navz[i])
                     for i in range(len(xy))])
    inside_cut = shapely.contains_xy(removed, xy[:, 0], xy[:, 1])
    seed &= ~inside_cut
    shape = gx.shape
    ground = ground.reshape(shape); known = known.reshape(shape); seed = seed.reshape(shape)
    reach = seed.copy()
    queue = deque(zip(*np.nonzero(seed)))
    while queue:
        i, j = queue.popleft()
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = i + di, j + dj
            if 0 <= a < shape[0] and 0 <= b < shape[1] and not reach[a, b] and known[a, b] \
                    and abs(ground[a, b] - ground[i, j]) <= low:
                reach[a, b] = True; queue.append((a, b))
    cells = reach.ravel() & inside_cut
    cells[cells] = ground.ravel()[cells] - plane_z(xy[cells]) >= low - RAISED
    floor = ground.ravel()[cells]; cxy = xy[cells]
    clear = ~np.isfinite(rays.vertical(np.c_[cxy, floor + low], True, high - low)) if len(cxy) else np.zeros(0, bool)
    if clear.any():
        clear[clear] = ~enclosed(solids, cxy[clear], floor[clear] + low)
    h = CELL * 0.75   # half a cell wider, so no carved sliver survives between walkable cells
    walkable = shapely.union_all(shapely.box(cxy[clear, 0] - h, cxy[clear, 1] - h, cxy[clear, 0] + h, cxy[clear, 1] + h)) \
        if clear.any() else shapely.Polygon()
    # leftover parts the cell grid does not resolve (smaller than two cells, or narrower than a cell everywhere, such
    # as slivers along a Nav edge): walkable when their own floor steps onto a reached cell and is clear
    rest = [part for part in shapely.get_parts(shapely.difference(removed, walkable))
            if part.area < 2 * CELL * CELL or part.buffer(-CELL / 2).is_empty]
    reached = np.nonzero(reach.ravel())[0]
    if rest and len(reached):
        from scipy.spatial import cKDTree
        pxy = shapely.get_coordinates(shapely.point_on_surface(rest))
        pfloor = floor_heights(rays, pxy, plane_z(pxy) - SEED_BELOW, plane_z(pxy) + high + 1.0, high, surfaces=surfaces)
        d, nb = cKDTree(xy[reached]).query(pxy)
        g = ground.ravel()[reached[nb]]
        ok = np.isfinite(pfloor) & (d <= 2 * CELL) & (np.abs(pfloor - g) <= low) & (pfloor - plane_z(pxy) >= low - RAISED)
        if ok.any():
            ok[ok] = ~np.isfinite(rays.vertical(np.c_[pxy[ok], pfloor[ok] + low], True, high - low))
        if ok.any():
            ok[ok] = ~enclosed(solids, pxy[ok], pfloor[ok] + low)
        extra = [part for part, good in zip(rest, ok) if good]
        if extra:
            walkable = shapely.union_all([walkable, *extra])
    return walkable.intersection(removed) if not walkable.is_empty else walkable
