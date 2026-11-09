"""Footholds without nav: standable static collision tops (crates, pipes, beams) a move from nav can land on.

Candidates require body clearance, a supported footprint and no kill volume; nav and its fringe are excluded.
"""

import numpy as np
from scipy.spatial import cKDTree

from ..config import configuration

PLAYER = configuration("build")["reach"]["player"]
SETTINGS = configuration("build")["reach"]["footholds"]
SNAP = SETTINGS["snap"]              # a landing point this close to a foothold lands on that foothold
FOOT = SETTINGS["footRadius"]        # supported disc under a standing player (capsule bottom)
WALL = SETTINGS["wallClearance"]     # free room around the body at body heights
NAV_GAP = SETTINGS["navGap"]         # points this close to nav at nav height are nav fringe, not footholds
NAV_DZ = SETTINGS["navHeight"]
RISE = SETTINGS["rise"]              # samples look for regions and footholds up to this far above them
TOP_SPACING = SETTINGS["topSpacing"]     # sample spacing on large walkable collision faces
TOP_NEAR_NAV = SETTINGS["topNearNav"]    # only tops this close to nav (3D) can be footholds of a jump from nav
TOP_DEDUPE = SETTINGS["topDedupe"]       # one candidate per cell of this size
BODY = PLAYER["moverHeight"]
MAX_SLOPE_COS = np.cos(PLAYER["moverMaxSlope"])
RING = np.array([[np.cos(t), np.sin(t), 0.0] for t in np.linspace(0, 2 * np.pi, 8, endpoint=False)])
UP = np.array([0, 0, 1.0]); DOWN = -UP


class NavFringe:
    """Reference points on walkable nav (vertices, centres, edge points), each with its nav triangle."""

    def __init__(self, nav_tris, unsupported):
        tri = np.nonzero(~unsupported)[0]
        walk = nav_tris[tri]
        ref, owner = [walk.reshape(-1, 3), walk.mean(1)], [np.repeat(tri, 3), tri]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            for t in (0.25, 0.5, 0.75):
                ref.append(walk[:, a] + (walk[:, b] - walk[:, a]) * t); owner.append(tri)
        self.ref = np.concatenate(ref); self.owner = np.concatenate(owner)
        self.tree = cKDTree(self.ref[:, :2])

    def nearest(self, p, dz=0.3):
        """(nav triangle, reference point) of the closest nav point within NAV_GAP at a similar height, or None."""
        best = None
        for i in self.tree.query_ball_point(p[:2], NAV_GAP):
            d = abs(self.ref[i, 2] - p[2])
            if d <= dz:
                h = np.linalg.norm(self.ref[i, :2] - p[:2]) + d
                if best is None or h < best[0]:
                    best = (h, i)
        return None if best is None else (int(self.owner[best[1]]), self.ref[best[1]])

    def near(self, pts):
        """Mask of points within NAV_GAP of a nav reference point (in plan) at a height within NAV_DZ."""
        hits = self.tree.query_ball_point(pts[:, :2], NAV_GAP)
        count = np.fromiter((len(h) for h in hits), int, len(hits))
        if not count.sum():
            return np.zeros(len(pts), bool)
        ref = np.concatenate([h for h in hits if h]).astype(int)
        point = np.repeat(np.arange(len(pts)), count)
        close = np.abs(self.ref[ref, 2] - pts[point, 2]) < NAV_DZ
        return np.bincount(point[close], minlength=len(pts)) > 0


def standable(pts, rays, support, fringe, kill):
    """Mask of points a player can stand on that are not nav (fringe None: the points are nav already)."""
    pts = np.asarray(pts, float)
    ok = open_above(pts, rays, fringe)
    ok[ok] = supported(pts[ok], rays, support, kill)
    return ok


def open_above(pts, rays, fringe):
    """The cheap part of standable: not nav fringe, nothing above within the body height."""
    ok = ~fringe.near(pts) if fringe is not None and len(pts) else np.ones(len(pts), bool)
    idx = np.nonzero(ok)[0]
    if len(idx):
        head = rays.vertical(pts[idx] + UP * 0.05, True, BODY)
        ok[idx[np.isfinite(head)]] = False
    return ok


def supported(pts, rays, support, kill):
    """The costly part of standable: wall clearance around the body, a supported footprint, no kill volume."""
    ok = np.ones(len(pts), bool)
    idx = np.nonzero(ok)[0]
    if len(idx):
        o = np.concatenate([np.repeat(pts[idx] + UP * h, 8, axis=0) for h in (0.5, 1.2)])
        wall = rays.batched(o, np.tile(RING, (2 * len(idx), 1)), np.full(len(o), WALL)).reshape(2, len(idx), 8)
        ok[idx[np.isfinite(wall).any(axis=(0, 2))]] = False
    idx = np.nonzero(ok)[0]
    if len(idx):
        o = np.repeat(pts[idx] + UP * 0.1, 8, axis=0) + np.tile(RING * FOOT, (len(idx), 1))
        foot = support.batched(o, np.tile(DOWN, (len(o), 1)), np.full(len(o), 0.25)).reshape(len(idx), 8)
        ok[idx[~np.isfinite(foot).all(axis=1)]] = False
    idx = np.nonzero(ok)[0]
    if len(idx) and kill is not None:
        k = kill.batched(pts[idx] + UP * 0.05, np.tile(UP, (len(idx), 1)), np.full(len(idx), BODY))
        ok[idx[np.isfinite(k)]] = False
    return ok


def settle(pts, rays, support, fringe, kill, step=0.15, rings=2):
    """Per landing point, a standable point on the same top within rings * step of it (the player lands a little
    further in), or None. Offsets are tried in order; each point stops at its first standable one."""
    pts = np.asarray(pts, float)
    out = [None] * len(pts)
    todo = np.arange(len(pts))
    for offset in [np.zeros(3)] + [r * step * k for k in range(1, rings + 1) for r in RING]:
        if not len(todo):
            break
        cand = pts[todo] + offset
        ok = standable(cand, rays, support, fringe, kill)
        for j, c in zip(todo[ok], cand[ok]):
            out[j] = c
        todo = todo[~ok]
    return out


def candidate_tops(tris, nav_points, rays, support, fringe, kill):
    """Standable points on walkable collision faces (slope within the mover limit) that are not nav: crate tops,
    beams, the upper band of pipes. Found up front so moves can aim at them like players do."""
    tris = np.asarray(tris, float)
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    norm = np.linalg.norm(n, axis=1)
    tris = tris[(norm > 1e-9) & (n[:, 2] >= MAX_SLOPE_COS * np.maximum(norm, 1e-9))]
    if not len(tris):
        return np.zeros((0, 3))
    d, _ = cKDTree(nav_points).query(tris.mean(1), distance_upper_bound=TOP_NEAR_NAV)
    tris = tris[np.isfinite(d)]
    pts = [tris.mean(1)]
    edge = np.max(np.linalg.norm(tris - np.roll(tris, 1, axis=1), axis=2), axis=1)
    for t in tris[edge > 2 * TOP_SPACING]:
        k = int(np.ceil(np.max(np.linalg.norm(t - np.roll(t, 1, axis=0), axis=1)) / TOP_SPACING))
        u, v = np.meshgrid(np.arange(k + 1), np.arange(k + 1))
        keep = (u + v) <= k
        u, v = u[keep] / k, v[keep] / k
        pts.append(t[0] + np.outer(u, t[1] - t[0]) + np.outer(v, t[2] - t[0]))
    pts = np.concatenate(pts)
    # Test before deduplicating: a cell's first point may be obstructed while a later one is standable.
    pts = pts[open_above(pts, rays, fringe)]
    _, cell = np.unique(np.floor(pts / TOP_DEDUPE).astype(np.int64), axis=0, return_inverse=True)
    cell = cell.ravel()
    order = np.argsort(cell, kind="stable")
    rank = np.empty(len(pts), int)
    rank[order] = np.arange(len(pts)) - np.searchsorted(cell[order], cell[order])
    chosen = np.full(cell.max() + 1 if len(cell) else 0, -1)
    for r in range(rank.max() + 1 if len(rank) else 0):
        idx = np.nonzero((rank == r) & (chosen[cell] < 0))[0]
        if not len(idx):
            break
        ok = supported(pts[idx], rays, support, kill)
        chosen[cell[idx[ok]]] = idx[ok]
    return pts[np.sort(chosen[chosen >= 0])]
