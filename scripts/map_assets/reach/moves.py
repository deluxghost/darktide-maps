"""Player moves from nav boundary samples: step-offs, drops, standing and running jumps, and ledge vaults.

A sample is a point on a region's boundary with an outward direction (the edge normal, or aimed at a target). Each
lift (step-up, jump apex, ledge vault) is tested at a series of distances: the body must fit ahead at that height
(ray fan plus a swept slab, so thin bars and grilles block), the landing must be within the fall-damage height, a
fall must have a shaft the body fits through, and the path must not cross a kill volume or a hang ledge that would
catch the falling body. Jumps the flat model finds blocked may still pass under the obstacle on their real arc.
"""

import collections

import numpy as np

from ..config import configuration
from .rays import body_sweep

PLAYER = configuration("build")["reach"]["player"]
SETTINGS = configuration("build")["reach"]["moves"]
STEP, JUMP, VAULT = PLAYER["stepHeight"], PLAYER["jumpApex"], PLAYER["ledgeVaultHeight"]
LIFTS = (STEP, JUMP, VAULT)
DISTANCES = tuple(SETTINGS["distances"])
WALK_REACH = SETTINGS["walkReach"]          # step-offs and vaults; only running jumps go farther
NORMAL_REACH = SETTINGS["normalReach"]      # edge-normal samples; longer jumps are aimed at their target
SPRINT, WALK = PLAYER["sprintSpeed"], PLAYER["walkSpeed"]
JUMP_V, GRAVITY = PLAYER["jumpSpeed"], PLAYER["gravity"]
NAV_INSET = PLAYER["navAgentRadius"]        # nav edges sit this far inside real edges, on both sides of a gap
AIR_LEDGE = PLAYER["airLedgeVaultHeight"]   # in-air ledge vault
MAX_DROP = PLAYER["safeFallHeight"]
BODY = PLAYER["moverHeight"]
PLAYER_R = PLAYER["moverRadius"]
HANG_R = PLAYER["hangCapsuleRadius"]
LATERAL = (-SETTINGS["lateralOffset"], 0.0, SETTINGS["lateralOffset"])
HEIGHTS = (0.05, 0.85, BODY - 0.05)
SWEEP_HALF = SETTINGS["sweepHalfWidth"]
ARC_SEGMENTS = SETTINGS["arcSegments"]
SHAFT_R = SETTINGS["shaftRadius"]           # no ledge this close under a falling body
SHAFT_WIDTH = SETTINGS["shaftWidth"]        # a fall shaft at least this wide across (in game Mover.radius 0.545)
SHAFT_DROP = SETTINGS["shaftDrop"]          # falls deeper than this are checked for the shaft
SHAFT_STEP = SETTINGS["shaftStep"]          # heights at which the shaft width is measured
RING = np.array([[np.cos(a), np.sin(a), 0.0] for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)])
UP = np.array([0, 0, 1.0]); DOWN = -UP
WALL_PROBES = (0.6, 1.4)                    # heights of the rays that keep a sample on its triangle's side of a wall


def running_reach(dz, vz=JUMP_V):
    """Farthest nav-edge to nav-edge distance of a running jump (vz 0: sprinting off the edge) onto a ledge dz
    higher: the body must reach the ledge while it is at most AIR_LEDGE above the feet (the in-air vault takes
    over), and the front of the body touches it one radius before the centre."""
    disc = vz ** 2 - 2 * GRAVITY * (dz - AIR_LEDGE)
    if disc < 0:
        return 0.0
    return SPRINT * (vz + disc ** 0.5) / GRAVITY + 2 * NAV_INSET + PLAYER_R


def boundary_samples(edges, spacing=SETTINGS["sampleSpacing"]):
    """edges: (a, b, opposite vertex, region). Returns (point, outward xy normal, region, triangle centre)."""
    out = []
    for ea, eb, opp, reg in edges:
        d = eb[:2] - ea[:2]; length = np.linalg.norm(d)
        if length < 1e-6:
            continue
        nrm = np.array([d[1], -d[0]]) / length
        if (opp[:2] - ea[:2]) @ nrm > 0:
            nrm = -nrm
        k = max(int(round(length / spacing)), 1)
        for j in range(k):
            out.append((ea + (eb - ea) * (j + 0.5) / k, nrm, reg, (ea + eb + opp) / 3))
    return out


def shaft_blocked(rays, support, start_z, top, land):
    """A fall deeper than SHAFT_DROP needs a shaft the body fits through, from the floor it leaves (with the body
    above it) down to the landing: no ledge within SHAFT_R under the column, and at every height the free width
    across each of four axes at least SHAFT_WIDTH."""
    if top[2] - land[2] <= SHAFT_DROP:
        return False
    first = support.vertical(top + SHAFT_R * RING, False, top[2] - land[2] + 0.3)
    if (top[2] - first > land[2] + 0.5).any():
        return True
    heights = np.arange(land[2] + 0.3, start_z + BODY, SHAFT_STEP)
    if not len(heights):
        return False
    origins = np.repeat(np.c_[np.full((len(heights), 2), land[:2]), heights], 8, axis=0)
    idx = rays.candidates(np.r_[land[:2] - SHAFT_WIDTH, heights[0]], np.r_[land[:2] + SHAFT_WIDTH, heights[-1]])
    if not len(idx):
        return False
    t = rays.intersect(origins, np.tile(RING, (len(heights), 1)), np.full(len(origins), SHAFT_WIDTH), idx)
    t = np.minimum(t.reshape(len(heights), 8), SHAFT_WIDTH)
    return bool((t[:, :4] + t[:, 4:] < SHAFT_WIDTH - 1e-3).any())     # opposite directions k and k + 4


def arc_clear(rays, s, dir3, side, dist, vz):
    """A jump the flat (apex height) model finds blocked may still pass under the obstacle on its way down: test
    the body along the real parabola in ARC_SEGMENTS pieces, each with the band its height spans."""
    speed = SPRINT if dist > WALK_REACH else WALK
    xs = np.linspace(0.0, dist, ARC_SEGMENTS + 1)
    bands, windows = [], []
    for x0, x1 in zip(xs, xs[1:]):
        ts = np.linspace(x0, x1, 5) / speed
        z = vz * ts - 0.5 * GRAVITY * ts ** 2
        bands.append((s[2] + z.min() + 0.05, s[2] + z.max() + BODY)); windows.append((max(x0, 0.05), x1))
    far = s[:2] + dir3[:2] * dist; pad = SWEEP_HALF + 0.1
    lo = np.r_[np.minimum(s[:2], far) - pad, min(b[0] for b in bands) - 0.1]
    hi = np.r_[np.maximum(s[:2], far) + pad, max(b[1] for b in bands) + 0.1]
    hits = body_sweep(rays.t[rays.candidates(lo, hi)], s, dir3, side, SWEEP_HALF, bands, dist, windows)
    return not np.isfinite(hits).any()


class MoveFinder:
    """Moves from samples. locate(point, with_center) -> region (and the nav point it lies on) or None;
    has_neighbor(sample, region): another region is within move range; quick_locate: nav-only locate."""

    def __init__(self, rays, support, locate, quick_locate, has_neighbor, kill=None, hang=None):
        self.rays, self.support, self.kill, self.hang = rays, support, kill, hang
        self.locate, self.quick_locate, self.has_neighbor = locate, quick_locate, has_neighbor
        self.tested = set()
        self.side_cache = {}
        self.rejected = collections.Counter()

    def same_side(self, a, b):
        """Point b is reachable in a straight line from a (inside one nav triangle) without crossing a wall."""
        key = (round(a[0], 2), round(a[1], 2), round(a[2], 2), round(b[0], 1), round(b[1], 1), round(b[2], 1))
        ok = self.side_cache.get(key)
        if ok is None:
            d = b - a; length = np.linalg.norm(d)
            if length < 1e-3:
                ok = True
            else:
                o = np.array([a + [0, 0, h] for h in WALL_PROBES])
                idx = self.rays.candidates(np.minimum(a, b) - 0.05, np.maximum(a, b) + [0.05, 0.05, max(WALL_PROBES) + 0.05])
                ok = not np.isfinite(self.rays.intersect(o, np.tile(d / length, (len(o), 1)),
                                                         np.full(len(o), length), idx)).any()
            self.side_cache[key] = ok
        return ok

    def hazardous(self, s, dir3, dist, feet, top, land, side):
        if self.kill is not None:
            if any(self.kill.cast(np.array([s[0], s[1], feet + h]), dir3, dist) is not None for h in (0.05, 0.85)):
                return "kill"
            if self.kill.cast(top, DOWN, top[2] - land[2] + 0.05) is not None:
                return "kill"
        if self.hang is not None and land[2] < s[2] - 0.5:      # falling past a hang ledge catches the body
            for along, across in ((0, 0), (HANG_R, 0), (-HANG_R, 0), (0, HANG_R), (0, -HANG_R)):
                o = top + dir3 * along + side * across
                if self.hang.cast(o + UP, DOWN, o[2] + 1.0 - land[2] + 0.2) is not None:
                    return "hang"
        return None

    def find(self, samples, reached, misses):
        """Moves (from region, to region, start, landing, lift) of the samples. reached(region) tells regions
        already reachable; landings on collision that is not nav are appended to misses (possible footholds)."""
        rays, support = self.rays, self.support
        moves = []
        for smp in samples:
            s, nrm, ra, cen = smp[:4]
            dmax = smp[4] if len(smp) > 4 else NORMAL_REACH
            # a sample aimed at a foothold also tests the foothold's own distance, and a landing there counts as a
            # foothold at any height (the player aims at it)
            target = smp[5] if len(smp) > 5 else None
            dists = DISTANCES if target is None else tuple(sorted(set(DISTANCES) | {round(float(target), 2)}))
            if not self.has_neighbor(s, ra) or not self.same_side(cen, s):
                continue
            dir3 = np.r_[nrm, 0.0]; side = np.r_[-nrm[1], nrm[0], 0.0]
            tops = np.array([[s[0] + nrm[0] * dist, s[1] + nrm[1] * dist, s[2] + lift + 0.3]
                             for lift in LIFTS for dist in dists])
            sidx = support.candidates(np.r_[tops[:, :2].min(0) - 0.1, s[2] - MAX_DROP - 1.0],
                                      np.r_[tops[:, :2].max(0) + 0.1, s[2] + max(LIFTS) + 0.5])
            sidx = support.strip(sidx, s, nrm, max(dists), 0.15)
            land_t = support.intersect(tops, np.broadcast_to(DOWN, tops.shape),
                                       np.array([lift + 0.3 + MAX_DROP for lift in LIFTS for _ in dists]), sidx)
            land_t = land_t.reshape(len(LIFTS), len(dists))
            within = np.array(dists) <= dmax
            landable = np.isfinite(land_t) & within
            if not landable.any():
                continue
            # skip the body checks when every landing spot is the own region or already reached; a landing off nav
            # may still be a foothold
            if not any(rb is None or rb != ra and not reached(rb)
                       for rb in (self.quick_locate(tops[li * len(dists) + di] - [0, 0, land_t[li, di]])
                                  for li, di in zip(*np.nonzero(landable)))):
                continue
            reach = max(d for d, ok in zip(dists, landable.any(0)) if ok)
            far = s[:2] + nrm * reach
            pad = max(LATERAL) + 0.05
            idx = rays.candidates(np.r_[np.minimum(s[:2], far) - pad, s[2] - 0.2],
                                  np.r_[np.maximum(s[:2], far) + pad, s[2] + max(LIFTS) + BODY + 0.3])
            idx = rays.strip(idx, s, nrm, reach, max(LATERAL) + SWEEP_HALF + 0.1)
            head_t = rays.intersect((s + UP * 0.1)[None], UP[None], np.array([max(LIFTS) + BODY]), idx)[0]
            # nearest obstruction per lift: horizontal ray fan against the triangles spanning that lift's body,
            # then the swept body slab (catches thin bars) for lifts that still have something to land on
            horiz = np.full(len(LIFTS), np.inf)
            offsets = np.repeat(side[None] * np.array(LATERAL)[:, None], len(HEIGHTS), axis=0)
            zlo, zhi = rays.zlo[idx], rays.zhi[idx]
            for li, lift in enumerate(LIFTS):
                sub = idx[(zlo <= s[2] + lift + max(HEIGHTS) + 1e-6) & (zhi >= s[2] + lift + min(HEIGHTS) - 1e-6)]
                if len(sub):
                    o = np.array([[s[0], s[1], s[2] + lift + h] for _ in LATERAL for h in HEIGHTS]) + offsets
                    horiz[li] = rays.intersect(o, np.broadcast_to(dir3, o.shape), np.full(len(o), reach), sub).min()
            todo = [li for li, lift in enumerate(LIFTS)
                    if horiz[li] >= 2 * PLAYER_R and head_t > lift + BODY and landable[li].any()]
            if todo:
                swept = body_sweep(rays.t[idx], s, dir3, side, SWEEP_HALF,
                                   [(s[2] + LIFTS[li] + 0.05, s[2] + LIFTS[li] + BODY) for li in todo], reach)
                for li, h in zip(todo, swept):
                    horiz[li] = min(horiz[li], h)
            moves.extend(self.landings(smp, dists, dmax, target, tops, land_t, head_t, horiz, misses, dir3, side))
        return moves

    def landings(self, smp, dists, dmax, target, tops, land_t, head_t, horiz, misses, dir3, side):
        s, nrm, ra = smp[:3]
        found = set()
        base_key = (round(s[0], 1), round(s[1], 1), round(s[2], 1), int(ra), round(nrm[0], 1), round(nrm[1], 1))
        for li, lift in enumerate(LIFTS):
            if head_t <= lift + BODY:
                break
            feet = s[2] + lift
            for di, dist in enumerate(dists):
                if dist > dmax:
                    break
                key = (base_key, lift, dist)
                if key in self.tested:
                    continue
                self.tested.add(key)
                top = tops[li * len(dists) + di]
                t = land_t[li, di]
                arc = None
                if horiz[li] <= dist or horiz[li] < 2 * PLAYER_R:
                    # flat model blocked: a step-off or jump to a lower landing may still pass under the obstacle
                    # on the way down (its arc is tested once the landing is worth it)
                    if not (lift in (STEP, JUMP) and np.isfinite(t) and top[2] - t < s[2] - 0.3
                            and horiz[li] >= 2 * PLAYER_R):
                        if lift not in (STEP, JUMP) or not np.isfinite(t):
                            break        # target behind the obstacle, or no room ahead for the body
                        continue
                    arc = 0.0 if lift == STEP else JUMP_V
                if not np.isfinite(t):
                    continue
                land = top + DOWN * t
                if dist > WALK_REACH and not (lift == JUMP and dist <= running_reach(land[2] - s[2])
                                              or lift == STEP and dist <= running_reach(land[2] - s[2], 0.0)):
                    continue             # only a running jump, or sprinting off a higher edge, gets this far

                def clear():
                    return arc is None or arc_clear(self.rays, s, dir3, side, dist, arc)
                hit = self.locate(land, with_center=True)
                if hit is None:
                    # landed on collision that is not walkable nav (a crate top...): a possible foothold
                    if (land[2] > s[2] + 0.3 or target is not None) \
                            and not shaft_blocked(self.rays, self.support, s[2], top, land) \
                            and not self.hazardous(s, dir3, dist, feet, top, land, side) and clear():
                        misses.append((int(ra), s, land, lift))
                    continue
                rb, land_cen = hit
                if rb == ra or rb in found or not self.same_side(land_cen, land):
                    continue
                if shaft_blocked(self.rays, self.support, s[2], top, land):
                    self.rejected["shaft"] += 1
                    continue
                if not clear():
                    continue
                why = self.hazardous(s, dir3, dist, feet, top, land, side)
                if why:
                    self.rejected[why] += 1
                    continue
                found.add(rb)
                yield int(ra), int(rb), s, land, lift
