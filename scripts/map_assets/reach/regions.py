"""Which parts of the carved nav a player can reach.

Regions are connected components of the carved nav after cutting adjacencies the player body cannot pass: shared
edges with less than the body's clearance from carved obstacles and the nav outline, crossings through a
player_mover_blocker above vault height, and the border of floorless nav confirmed void. Regions are reached from
player spawns and main path nodes, then region by region by moves (moves.py), ladders, player platforms, and
footholds on collision tops that are not nav (footholds.py), which carry reachability on without being regions.
"""

import collections

import numpy as np
import shapely
from scipy.spatial import cKDTree

from ..config import configuration
from ..terrain.ground import RAISED, SEED_BELOW, floor_heights
from . import footholds
from .inputs import collision_sets, hang_ledges, ladders, platform_docks, volume_triangles
from .moves import DISTANCES, MAX_DROP, WALK_REACH, MoveFinder, boundary_samples
from .rays import Rays

REACH = configuration("build")["reach"]
PLAYER, SETTINGS, MOVES = REACH["player"], REACH["regions"], REACH["moves"]
PLAYER_R = PLAYER["moverRadius"]
AGENT_R = PLAYER["navAgentRadius"]        # nav edges already keep this much from walls
CLEARANCE = {"carved": PLAYER_R, "outline": PLAYER_R - AGENT_R}
TERRAIN = configuration("build")["terrain"]
STEP_UP, BAND_TOP = TERRAIN["clearanceLow"], TERRAIN["clearanceHigh"]   # carving's step and body band (ground.py)
SIDE = 0.05                               # m; floor probes this far into each triangle of a shared edge
SLIVER = SETTINGS["sliverArea"]           # carved islands smaller than this are clipping leftovers, not obstacles
SOURCE_AREA = SETTINGS["sourceArea"]      # regions this large hold a player; smaller ones need a standable probe
SOURCE_PROBES = SETTINGS["sourceProbes"]
FLOOR_GAP = SETTINGS["floorGap"]          # nav with no collision this far below it has no floor
STAND_LIFT = SETTINGS["standLift"]        # a collision top this far above nav is the floor a move starts from
BLOCKER_HEIGHT = SETTINGS["blockerHeight"]    # blocker volumes below this are vaulted, not walls
SLIVER_LAND_R, SLIVER_LAND_DZ = SETTINGS["sliverLandRadius"], SETTINGS["sliverLandHeight"]
LADDER_STEP, LADDER_REACH, LADDER_DZ = SETTINGS["ladderStep"], SETTINGS["ladderReach"], SETTINGS["ladderHeight"]
ANCHOR_R, ANCHOR_DZ = SETTINGS["anchorRadius"], SETTINGS["anchorHeight"]
NEW_TARGET_RADIUS = MOVES["newTargetRadius"]  # a sample is skipped when every region this close is reached
AIM_TARGETS, AIM_OVERSHOOT = MOVES["aimTargets"], MOVES["aimOvershoot"]
AIM_SPREAD, AIM_DROP = MOVES["aimSpread"], MOVES["aimDrop"]
FH_TARGETS, FH_RISE, FH_MIN = MOVES["footholdTargets"], MOVES["footholdRise"], MOVES["footholdMinimum"]
FH_REGION_R, FH_REGION_DZ = MOVES["footholdRegionRadius"], MOVES["footholdRegionHeight"]
DOWN = np.array([0, 0, -1.0])
SPAWNER = "PlayerSpawner"
LANDING_CACHE_SIZE = 2048


def union_find(n, pairs):
    parent = np.arange(n)

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for a, b in pairs:
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[ra] = rb
    return np.array([root(i) for i in range(n)])


def edge_map(tris):
    edges = collections.defaultdict(list)
    for i, (a, b, c) in enumerate(tris.tolist()):
        for e in ((a, b), (b, c), (c, a)):
            edges[(min(e), max(e))].append(i)
    return edges


def edge_points(pos, edges, step):
    pts = []
    for a, b in edges:
        n = max(int(np.linalg.norm(pos[b] - pos[a]) / step), 1)
        pts.append(pos[a] + (pos[b] - pos[a]) * (np.arange(n + 1)[:, None] / n))
    return np.concatenate(pts) if pts else np.zeros((0, 3))


class Reachability:
    def __init__(self, packet, assets):
        terrain = packet["terrain"]
        self.mission = packet["id"]
        V = np.asarray(terrain["navmesh"]["vertices"], float)
        T = np.asarray([t[:3] for t in terrain["navmesh"]["triangles"]]) - 1
        R = np.asarray(terrain["removedMesh"]["positions"], float).reshape(-1, 3) - [0, 0, terrain["data"]["overlay_offset"]]
        RI = np.asarray(terrain["removedMesh"]["indices"], int).reshape(-1, 3)
        self.P = V[T]
        self.n = len(T)
        self.stats = collections.Counter()
        bounds = (V.min(0) - [10, 10, 40], V.max(0) + [10, 10, 10])
        blocking, support, envelopes = collision_sets(assets, packet["scene"], bounds)
        blockers = volume_triangles(packet["levelBlockers"])
        self.rays = Rays(np.concatenate([blocking, blockers]))
        self.ground = Rays(blocking)          # floors, as carving finds them: level collision without mover blockers
        raised = np.asarray(terrain["raisedMesh"]["positions"], float).reshape(-1, 3, 3)
        self.raised, self.raised_tree = raised, shapely.STRtree(shapely.polygons(raised[:, :, :2]))
        self.support = Rays(support)
        kill = volume_triangles(packet["killVolumes"])
        self.kill = Rays(kill) if len(kill) else None
        hang = hang_ledges(assets, packet["scene"], bounds)
        self.hang = Rays(hang) if len(hang) else None
        self.regions(V, T, R, RI, blockers, envelopes)
        self.packet, self.assets = packet, assets

    # ---- regions
    def regions(self, V, T, R, RI, blockers, envelopes):
        allv = np.vstack([V, R]); q = np.round(allv * 1000).astype(np.int64)
        _, inv = np.unique(q, axis=0, return_inverse=True); inv = inv.ravel()
        pos = np.zeros((inv.max() + 1, 3)); pos[inv] = allv
        TT = inv[T]; RT = inv[len(V) + RI] if len(RI) else np.zeros((0, 3), int)
        self.TT, self.pos = TT, pos
        nav_edges, red_edges = edge_map(TT), edge_map(RT)
        # clearance: adjacent nav triangles connect where some point of their shared edge leaves room for the body
        red_root = union_find(len(RT), [(ts[0], t) for ts in red_edges.values() for t in ts[1:]])
        red_area = collections.Counter()
        if len(RT):
            RP = pos[RT]
            for root, area in zip(red_root, 0.5 * np.linalg.norm(np.cross(RP[:, 1] - RP[:, 0], RP[:, 2] - RP[:, 0]), axis=1)):
                red_area[root] += area
        carved_outline = {e for e, ts in red_edges.items() if len(ts) == 1 and red_area[red_root[ts[0]]] >= SLIVER}
        outline = [e for e, ts in nav_edges.items() if len(ts) == 1 and e not in carved_outline]
        trees = {"carved": edge_points(pos, carved_outline, 0.1), "outline": edge_points(pos, outline, 0.1)}
        self.obstacles = {kind: cKDTree(points) for kind, points in trees.items() if len(points)}
        interior = [(e, ts) for e, ts in nav_edges.items() if len(ts) == 2]
        owner, qs = [], []
        for k, (e, _) in enumerate(interior):
            pa, pb = pos[e[0]], pos[e[1]]; m = max(int(np.linalg.norm(pb - pa) / 0.15), 2)
            qs.append(pa + (pb - pa) * (np.arange(1, m) / m)[:, None]); owner.append(np.full(m - 1, k))
        qs = np.concatenate(qs); owner = np.concatenate(owner)
        ok = self.clear(qs)
        # one step across: the floors just inside both triangles meet within a step (nav kept for a raised floor
        # stands for that floor, which may lie far above nav at Nav level next to it)
        if ok.any():
            pair = np.array([ts for _, ts in interior])[owner[ok]]
            side = [qs[ok] + (P_c - qs[ok]) * (SIDE / np.maximum(np.linalg.norm(P_c - qs[ok], axis=1), SIDE))[:, None]
                    for P_c in (self.P[pair[:, 0]].mean(1), self.P[pair[:, 1]].mean(1))]
            ok[ok] = np.abs(self.floor(side[0]) - self.floor(side[1])) <= STEP_UP
        passable = np.zeros(len(interior), bool); passable[owner[ok]] = True
        cut = set(np.nonzero(~passable)[0].tolist())
        # player_mover_blocker: cut adjacency whose crossing hits a blocker above vault height
        P = self.P
        centers = P.mean(1)
        if len(blockers):
            blocker_rays = Rays(blockers)
            for k, (e, (ta, tb)) in enumerate(interior):
                a, b = centers[ta], centers[tb]
                d = b - a; length = np.linalg.norm(d)
                if length > 1e-6 and blocker_rays.cast(a + [0, 0, BLOCKER_HEIGHT], d / length, length) is not None:
                    cut.add(k)
        # nav with no collision under it is walkable (runtime-only floors) unless its floorless patch is listed void
        no_floor = ~np.isfinite(self.support.vertical(centers + [0, 0, 0.5], False, 0.5 + FLOOR_GAP))
        for pivot, radius in envelopes:
            no_floor &= np.linalg.norm(centers - pivot, axis=1) > radius + 0.5   # held there in another pose
        patch = union_find(self.n, [ts for e, ts in interior if no_floor[ts[0]] and no_floor[ts[1]]])
        void = set()
        for point in REACH["voidNav"].get(self.mission, []):
            cand = np.nonzero(no_floor)[0]
            k = cand[np.argmin(np.linalg.norm(centers[cand] - point, axis=1))] if len(cand) else None
            if k is None or np.linalg.norm(centers[k] - point) > 8.0:
                raise ValueError(f"{self.mission}: no floorless nav near void nav point {point}")
            void.add(patch[k])
        self.unsupported = no_floor & np.isin(patch, list(void))
        for k, (e, (ta, tb)) in enumerate(interior):
            if self.unsupported[ta] != self.unsupported[tb]:
                cut.add(k)
        self.cut_keys = {interior[k][0] for k in cut}
        roots = union_find(self.n, [ts for k, (e, ts) in enumerate(interior) if k not in cut])
        ids = {r: k for k, r in enumerate(dict.fromkeys(roots.tolist()))}
        self.region = np.array([ids[r] for r in roots])
        self.region_count = len(ids)
        self.area = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
        self.region_area = np.bincount(self.region, weights=self.area, minlength=len(ids))
        self.nav_edges = nav_edges
        # nav kept for a raised floor stands for that floor everywhere a height is compared (landing, centres, starts)
        floor = self.floor(centers)
        self.lift = np.where(self.on_raised(centers), floor - centers[:, 2], 0.0)
        self.adjacent = np.array([ts for e, ts in interior]).reshape(-1, 2)
        self.stats.update(cutEdges=len(cut), regions=len(ids))

    def floor(self, points):
        """Real floor height under nav points, as carving judges it (ground.py): where carving kept nav for a raised
        floor, that floor (floor_heights); elsewhere the floor at Nav level, the first surface from just under a step
        above the point down to SEED_BELOW below it, or the point itself."""
        out = points[:, 2].copy()
        low = points + [0, 0, STEP_UP - RAISED]
        drop = self.ground.vertical(low, False, STEP_UP - RAISED + SEED_BELOW)
        out[np.isfinite(drop)] = (low[:, 2] - drop)[np.isfinite(drop)]
        raised = self.on_raised(points)
        if raised.any():
            z = points[raised, 2]
            found = floor_heights(self.ground, points[raised, :2], z - SEED_BELOW, z + BAND_TOP + 1.0, BAND_TOP)
            out[raised] = np.where(np.isfinite(found), found, out[raised])
        return out

    def on_raised(self, points):
        """Points on nav that carving kept for a raised floor (within a centimetre of that nav's plane)."""
        inside = np.zeros(len(points), bool)
        if not len(self.raised):
            return inside
        i, t = self.raised_tree.query(shapely.points(points[:, :2]), predicate="intersects")
        tri = self.raised[t]; n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        flat = np.abs(n[:, 2]) > 1e-12
        z = np.einsum("ij,ij->i", n, tri[:, 0]) - n[:, 0] * points[i, 0] - n[:, 1] * points[i, 1]
        z = np.where(flat, z / np.where(flat, n[:, 2], 1.0), tri[:, :, 2].mean(1))
        inside[i[np.abs(z - points[i, 2]) <= 0.01]] = True
        return inside

    def clear(self, points):
        """Points that leave room for the player body: at least its radius from carved obstacles, and the body's
        margin beyond the nav agent radius from the nav outline."""
        ok = np.ones(len(points), bool)
        for kind, tree in self.obstacles.items():
            dist, _ = tree.query(points, distance_upper_bound=CLEARANCE[kind])
            ok &= dist >= CLEARANCE[kind]
        return ok

    # ---- point location
    def build_index(self):
        P = self.P
        self.mn = P[:, :, :2].min(1); self.mx = P[:, :, :2].max(1)
        grid = collections.defaultdict(list)
        lo = np.floor(self.mn / 2.0).astype(int); hi = np.floor(self.mx / 2.0).astype(int)
        for i in range(self.n):
            for x in range(lo[i, 0], hi[i, 0] + 1):
                for y in range(lo[i, 1], hi[i, 1] + 1):
                    grid[(x, y)].append(i)
        self.cells = {k: np.array(v) for k, v in grid.items()}
        self.e1 = P[:, 1, :2] - P[:, 0, :2]; self.e2 = P[:, 2, :2] - P[:, 0, :2]
        self.det = self.e1[:, 0] * self.e2[:, 1] - self.e1[:, 1] * self.e2[:, 0]
        self.cent = P.mean(1) + np.c_[np.zeros((self.n, 2)), self.lift]; self.tree = cKDTree(self.cent[:, :2])
        self.landing_cache = collections.OrderedDict()

    def seed_triangle(self, pt):
        """Nav triangle within the seed's vertical placement tolerance, or None."""
        x, y, z = pt; best = None
        P = self.P
        for i in np.nonzero((self.mn[:, 0] <= x) & (self.mx[:, 0] >= x) & (self.mn[:, 1] <= y) & (self.mx[:, 1] >= y))[0]:
            if abs(self.det[i]) < 1e-12 or self.unsupported[i]:
                continue
            q = np.array([x, y]) - P[i, 0, :2]
            u = (q[0] * self.e2[i, 1] - q[1] * self.e2[i, 0]) / self.det[i]
            w = (self.e1[i, 0] * q[1] - self.e1[i, 1] * q[0]) / self.det[i]
            if u < -1e-6 or w < -1e-6 or u + w > 1 + 1e-6:
                continue
            dz = z - (P[i, 0, 2] + u * (P[i, 1, 2] - P[i, 0, 2]) + w * (P[i, 2, 2] - P[i, 0, 2]) + self.lift[i])
            if -0.6 <= dz <= 2.5 and (best is None or dz < best[0]):
                best = (dz, i)
        return None if best is None else best[1]

    def land_region(self, pt, tol=0.45, with_center=False):
        """Region of the nav under a landing point (the point may stand up to STAND_LIFT above it), or None."""
        # Nav ownership is fixed; cache exact coordinates without quantizing landing positions.
        key = (*pt, tol)
        cache = self.landing_cache
        if key in cache:
            i = cache[key]
            cache.move_to_end(key)
        else:
            i = self.landing_triangle(pt, tol)
            cache[key] = i
            if len(cache) > LANDING_CACHE_SIZE:
                cache.popitem(last=False)
        if i is None:
            return None
        return (int(self.region[i]), self.cent[i]) if with_center else int(self.region[i])

    def landing_triangle(self, pt, tol):
        cand = self.cells.get((int(np.floor(pt[0] / 2.0)), int(np.floor(pt[1] / 2.0))))
        if cand is None:
            return None
        cand = cand[(np.abs(self.det[cand]) >= 1e-12) & ~self.unsupported[cand]]
        if not len(cand):
            return None
        P = self.P
        q = pt[:2] - P[cand, 0, :2]; d = self.det[cand]
        u = (q[:, 0] * self.e2[cand, 1] - q[:, 1] * self.e2[cand, 0]) / d
        w = (self.e1[cand, 0] * q[:, 1] - self.e1[cand, 1] * q[:, 0]) / d
        inside = (u >= -1e-6) & (w >= -1e-6) & (u + w <= 1 + 1e-6)
        if not inside.any():
            return None
        c = cand[inside]; u, w = u[inside], w[inside]
        z = P[c, 0, 2] + u * (P[c, 1, 2] - P[c, 0, 2]) + w * (P[c, 2, 2] - P[c, 0, 2]) + self.lift[c]
        dz = pt[2] - z; fit = (dz >= -tol) & (dz <= max(tol, STAND_LIFT))
        if not fit.any():
            return None
        return int(c[int(np.argmin(np.where(fit, np.abs(dz), np.inf)))])

    def standable(self, r):
        """Anchors (ladder ends, docks, spawns, path nodes) need a region that holds a player: by area."""
        return r is not None and self.region_area[r] >= SOURCE_AREA

    def anchor(self, r, pt, radius=ANCHOR_R, dz=ANCHOR_DZ):
        """An anchor against a wall may sit on a sliver nobody can stand in; it then belongs to the nearest
        standable region."""
        if self.standable(r):
            return r
        best = None
        for i in self.tree.query_ball_point(pt[:2], radius):
            d = np.linalg.norm(self.cent[i, :2] - pt[:2]) + abs(self.cent[i, 2] - pt[2])
            if abs(self.cent[i, 2] - pt[2]) <= dz and self.standable(int(self.region[i])) and not self.unsupported[i] \
                    and (best is None or d < best[0]):
                best = (d, int(self.region[i]))
        return best[1] if best else r

    def near_region(self, pt, radius=ANCHOR_R, dz=ANCHOR_DZ):
        r = self.land_region(pt, tol=dz)
        if r is None:
            best = None
            for i in self.tree.query_ball_point(pt[:2], radius):
                d = np.linalg.norm(self.cent[i, :2] - pt[:2]) + abs(self.cent[i, 2] - pt[2])
                if abs(self.cent[i, 2] - pt[2]) <= dz and (best is None or d < best[0]):
                    best = (d, int(self.region[i]))
            r = None if best is None else best[1]
        return self.anchor(r, pt, radius, dz)

    def sliver_floor(self, r, pt):
        """Standable region whose nav is within SLIVER_LAND_R / SLIVER_LAND_DZ of a landing point, with no wall
        between (body-height rays), or None."""
        best = None
        for i in self.tree.query_ball_point(pt[:2], SLIVER_LAND_R):
            q = int(self.region[i])
            if q == r or not self.standable(q) or self.unsupported[i] or abs(self.cent[i, 2] - pt[2]) > SLIVER_LAND_DZ:
                continue
            d = np.linalg.norm(self.cent[i, :2] - pt[:2])
            if best is not None and d >= best[0]:
                continue
            v = np.r_[self.cent[i, :2] - pt[:2], 0.0]; length = np.linalg.norm(v)
            if length > 1e-3 and any(self.rays.cast(pt + [0, 0, h], v / length, length) is not None for h in (0.3, 0.9, 1.5)):
                continue
            best = (d, q)
        return None if best is None else best[1]

    # ---- move sources
    def samples(self):
        """Boundary samples of regions that can hold a player (outline and cut edges), on the floor they stand on."""
        source_ok = self.region_area >= SOURCE_AREA
        small = np.nonzero(~source_ok[self.region] & ~self.unsupported)[0]
        if len(small):   # a small region is a source if one of its largest triangles is standable
            order = np.lexsort((-self.area[small], self.region[small]))
            rs = self.region[small][order]
            rank = np.arange(len(rs)) - np.searchsorted(rs, rs)
            small = small[order[rank < SOURCE_PROBES]]
            fits = footholds.standable(self.cent[small], self.rays, self.support, None, self.kill)
            source_ok[np.unique(self.region[small[fits]])] = True
        edges = []
        for e, ts in self.nav_edges.items():
            if len(ts) == 1 or e in self.cut_keys:
                for t in ts:
                    opp = [v for v in self.TT[t] if v not in e]
                    if opp and source_ok[self.region[t]]:
                        edges.append((self.pos[e[0]], self.pos[e[1]], self.pos[opp[0]], int(self.region[t])))
        samples = boundary_samples(edges)
        if samples:   # where nav runs under a raised floor (doorway slab, threshold) the move starts on that floor
            sp = np.array([x[0] for x in samples])
            hit = self.support.vertical(sp + [0, 0, STAND_LIFT], False, STAND_LIFT + 0.3)
            floor = sp[:, 2] + STAND_LIFT - hit
            raised = np.isfinite(hit) & (floor > sp[:, 2] + 0.02)
            on_floor = self.on_raised(sp)
            if on_floor.any():
                floor[on_floor] = self.floor(sp[on_floor]); raised |= on_floor
            samples = [(np.r_[pt[:2], floor[i]] if raised[i] else pt, nrm, ra, cen)
                       for i, (pt, nrm, ra, cen) in enumerate(samples)]
        self.stats["samples"] = len(samples)
        return samples

    # ---- seeds and fixed links
    def seeds(self):
        result = {}
        points = [("spawn", u["position"]) for u in self.packet["scene"] if any(c["name"] == SPAWNER for c in u["components"])]
        for segment in (self.packet.get("mainPath") or {}).get("main_path_segments") or []:
            points += [("path", node) for node in segment["nodes"]]
        for kind, pt in points:
            pt = np.asarray(pt, float)
            i = self.seed_triangle(pt)
            if i is not None:
                result.setdefault(self.anchor(int(self.region[i]), pt), kind)
            elif kind == "spawn":   # spawned in a vehicle above the nav: its own nav nearby, and the ground below
                r = self.near_region(pt, SETTINGS["vehicleSpawnRadius"], SETTINGS["vehicleSpawnHeight"])
                if self.standable(r):
                    result.setdefault(r, kind)
                o = pt + [0, 0, 0.5]
                hit = self.support.cast(o, DOWN, SETTINGS["vehicleDrop"])
                if hit is not None:
                    land = o + DOWN * hit; r = self.land_region(land)
                    if r is not None:
                        result.setdefault(self.anchor(r, land), kind)
        return result

    def links(self):
        """Fixed links: every region at one dock of a player platform reaches every region at its other docks, and
        a ladder links every floor along its climb line (players grab it anywhere)."""
        links = collections.defaultdict(set)
        nav_tris = self.P
        for docks in platform_docks(self.packet["platforms"], nav_tris):
            regions = []
            for position, points in docks:
                rs = {self.anchor(r, np.asarray(q, float)) for q in points
                      for r in [self.land_region(np.asarray(q, float), tol=SETTINGS["dockSnapHeight"])] if r is not None}
                if not rs:
                    r = self.near_region(np.asarray(position, float) + [0, 0, 0.3], SETTINGS["dockRadius"], SETTINGS["dockHeight"])
                    rs = {r} if r is not None else set()
                regions.append(rs)
            for i, ri in enumerate(regions):
                for j, rj in enumerate(regions):
                    if i != j:
                        for a in ri:
                            links[a] |= rj - {a}
        for bottom, top in ladders(self.assets, self.packet["scene"]):
            ends = {r for r in (self.near_region(bottom), self.near_region(top)) if r is not None}
            length = float(np.linalg.norm(top - bottom))
            for f in np.linspace(0, 1, max(int(length / LADDER_STEP), 1) + 1)[1:-1]:
                r = self.near_region(bottom + (top - bottom) * f, radius=LADDER_REACH, dz=LADDER_DZ)
                if r is not None:
                    ends.add(r)
            for a in ends:
                links[a] |= ends - {a}
        return links

    # ---- propagation
    def run(self):
        """Reachable mask over the carved nav triangles."""
        if self.mission in REACH["notEvaluatedMissions"]:
            return ~self.unsupported
        self.build_index()
        samples = self.samples()
        aim_ref = footholds.NavFringe(self.P, self.unsupported)
        aim_region = self.region[aim_ref.owner]
        fh_pts = footholds.candidate_tops(self.rays.t, self.cent, self.rays, self.support, aim_ref, self.kill)
        fh_tree = cKDTree(fh_pts[:, :2]) if len(fh_pts) else None
        fh_regions = [np.unique(self.region[[i for i in self.tree.query_ball_point(q[:2], FH_REGION_R)
                                             if abs(self.cent[i, 2] - q[2]) <= FH_REGION_DZ]]) for q in fh_pts]
        self.stats["footholdCandidates"] = len(fh_pts)
        nav_count = self.region_count
        wp_pts, wp_reg = [], []        # footholds reached so far; each is a region id past the nav regions
        wp_tree = [None]

        def wp_find(pt, tol):
            if wp_tree[0] is None:
                return None
            best = None
            for i in wp_tree[0].query_ball_point(pt[:2], footholds.SNAP):
                dz = abs(wp_pts[i][2] - pt[2])
                if dz <= tol and (best is None or dz < best[0]):
                    best = (dz, i)
            return None if best is None else best[1]

        def locate_any(pt, tol=0.45, with_center=False):
            r = self.land_region(pt, tol, with_center)
            if r is not None:
                return r
            i = wp_find(pt, min(tol, 0.3))
            if i is not None:
                return (wp_reg[i], np.asarray(wp_pts[i])) if with_center else wp_reg[i]
            # nav is inset from real edges: landing on that strip is landing on the nav beside it
            near = aim_ref.nearest(np.asarray(pt, float))
            if near is None:
                return None
            return (int(self.region[near[0]]), near[1]) if with_center else int(self.region[near[0]])

        def neighbor_any(s, ra):
            for i in self.tree.query_ball_point(s[:2], max(DISTANCES) + 1.5):
                if self.region[i] != ra and s[2] - MAX_DROP - 1.0 <= self.cent[i, 2] <= s[2] + footholds.RISE:
                    return True
            return wp_tree[0] is not None and any(wp_reg[i] != ra for i in
                                                  wp_tree[0].query_ball_point(s[:2], max(DISTANCES) + 1.5))

        def aims(base, footholds_only):
            """Players aim at what they jump to: besides the edge normal, a sample faces regions not reached yet
            within reach in front of it (up to AIM_TARGETS: the nearest point of each, and for long jumps the nearest
            point per AIM_SPREAD sector, since a player picks the clear line), or footholds near unreached regions."""
            out = []
            pts = np.array([x[0] for x in base])
            tree = fh_tree if footholds_only else aim_ref.tree
            if tree is None:
                return out
            for (pt, nrm, ra, cen), near in zip(base, tree.query_ball_point(pts[:, :2], max(DISTANCES))):
                if not near:
                    continue
                if footholds_only:
                    out += foothold_aims(pt, nrm, ra, cen, near)
                else:
                    out += region_aims(pt, nrm, ra, cen, np.asarray(near))
            return out

        def region_aims(pt, nrm, ra, cen, near):
            q = aim_ref.ref[near]; rb = aim_region[near]
            keep = (rb != ra) & (q[:, 2] >= pt[2] - AIM_DROP) & (q[:, 2] <= pt[2] + 1.6)
            if not keep.any():
                return []
            q, rb = q[keep], rb[keep]
            ur, inv = np.unique(rb, return_inverse=True)
            keep = np.array([int(x) not in via for x in ur], bool)[inv]
            if not keep.any():
                return []
            q, rb = q[keep], rb[keep]
            d = np.linalg.norm(q[:, :2] - pt[:2], axis=1)
            v = (q[:, :2] - pt[:2]) / np.maximum(d, 1e-6)[:, None]
            cosn = v @ nrm
            ok = (d > 0.3) & (cosn > 0.5) & (cosn < 0.985)      # outward, but not the edge normal itself
            if not ok.any():
                return []
            rb, d, v = rb[ok], d[ok], v[ok]
            sector = np.round(np.degrees(np.arctan2(nrm[0] * v[:, 1] - nrm[1] * v[:, 0], v @ nrm)) / AIM_SPREAD).astype(int)
            order = np.argsort(d)       # nearest point per (region, sector), in order of distance
            _, first = np.unique(np.stack([rb[order], sector[order]], 1), axis=0, return_index=True)
            best = {(int(rb[k]), int(sector[k])): k for k in order[np.sort(first)]}
            by_distance = sorted({r for r, _ in best}, key=lambda r: min(d[k] for (r2, _), k in best.items() if r2 == r))
            out = []
            for r in by_distance[:AIM_TARGETS]:
                ks = [k for (r2, _), k in best.items() if r2 == r]
                nearest = min(ks, key=lambda k: d[k])
                if d[nearest] <= WALK_REACH:
                    ks = [nearest]     # within walking reach the nearest point is enough; sectors are for long jumps
                out += [(pt, v[k], ra, cen, float(d[k]) + AIM_OVERSHOOT) for k in ks]
            return out

        def foothold_aims(pt, nrm, ra, cen, near):
            best = {}
            for i in near:
                q = fh_pts[i]
                if not pt[2] - AIM_DROP <= q[2] <= pt[2] + FH_RISE:
                    continue
                dv = q[:2] - pt[:2]; dist = float(np.linalg.norm(dv))
                if dist < FH_MIN:
                    continue
                v = dv / dist
                if v @ nrm <= 0.5 or all(int(r) in via for r in fh_regions[i]):
                    continue
                sector = int(round(np.degrees(np.arctan2(nrm[0] * v[1] - nrm[1] * v[0], v @ nrm)) / AIM_SPREAD))
                if sector not in best or dist < best[sector][0]:
                    best[sector] = (dist, v)
            return [(pt, v, ra, cen, dist + AIM_OVERSHOOT, dist) for dist, v in sorted(best.values(), key=lambda x: x[0])[:FH_TARGETS]]

        finder = MoveFinder(self.rays, self.support, locate_any, self.land_region, neighbor_any, self.kill, self.hang)
        by_region = collections.defaultdict(list)
        for smp in samples:
            by_region[smp[2]].append(smp)
        links = self.links()
        seeds = self.seeds()
        via = dict.fromkeys(seeds)
        queue = collections.deque(seeds)

        def reach(rb):
            if rb not in via:
                via[rb] = True; queue.append(rb)

        def useful(todo):
            """Samples with nearby regions that have not been reached."""
            if not todo:
                return []
            near = self.tree.query_ball_point(np.array([x[0][:2] for x in todo]), NEW_TARGET_RADIUS)
            return [x for x, nb in zip(todo, near)
                    if any(int(self.region[i]) not in via
                           and x[0][2] - MAX_DROP - 1.0 <= self.cent[i, 2] <= x[0][2] + footholds.RISE + 1.6 for i in nb)]

        def expand(todo):
            misses = []
            found = list(finder.find(todo, lambda rb: rb in via, misses))
            if misses:   # landings on collision tops that pass the strict standing checks become footholds
                for (ra, s0, land, lift), good in zip(misses, footholds.settle(
                        np.array([m[2] for m in misses]), self.rays, self.support, aim_ref, self.kill)):
                    if good is None:
                        continue
                    i = wp_find(good, 0.3)
                    if i is None:
                        i = len(wp_pts); wp_pts.append(np.asarray(good, float)); wp_reg.append(nav_count + i)
                        wp_tree[0] = cKDTree(np.array(wp_pts)[:, :2])
                        by_region[nav_count + i] = [(np.asarray(good, float), q[:2], nav_count + i, np.asarray(good, float))
                                                    for q in footholds.RING]
                    if wp_reg[i] != ra:
                        found.append((ra, wp_reg[i], s0, good, lift))
            # a landing on a sliver region (nav corner the clearance test cut off) is a landing on the floor it
            # continues into: the nearest standable region at that height
            for ra, rb, s0, land, lift in list(found):
                if rb < nav_count and not self.standable(rb):
                    alt = self.sliver_floor(rb, land)
                    if alt is not None and alt != ra:
                        found.append((ra, alt, s0, land, lift))
            self.stats["moves"] += len(found)
            for move in found:
                reach(move[1])

        deferred = []
        while queue or deferred:
            if not queue:
                # nav moves are exhausted: aim the kept samples that still face unreached regions at footholds
                batch, deferred = useful(deferred), []
                if batch:
                    expand(aims(batch, True))
                continue
            r = queue.popleft()
            for rb in sorted(links.get(r, ())):
                reach(rb)
            todo = useful(by_region.pop(r, []))
            if todo:
                deferred.extend(todo)
                expand(todo + aims(todo, False))
        self.stats.update(finder.rejected)
        self.stats["footholds"] = len(wp_pts)
        reached = np.zeros(nav_count, bool)
        reached[[r for r in via if r < nav_count]] = True
        return reached[self.region] & ~self.unsupported
