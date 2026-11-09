"""Clip offline Nav against eligible authored solid collision shapes."""

import json
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
import shapely
from scipy.spatial import cKDTree

from .world import CURVE_ERROR, CollisionAssets
from .ground import NavSurface, floor_queries, shape_triangles, walkable_cut
from .sections import AREA_EPSILON, project_shape
from ..config import configuration

CLEARANCE_LOW = configuration("build")["terrain"]["clearanceLow"]
CLEARANCE_HIGH = configuration("build")["terrain"]["clearanceHigh"]
# player_mover_blocker volumes are invisible walls, but low ones are invisible ramps and step pads. Only the part
# above the player's vault height (ledgeVault max) up to the mover height blocks movement.
BLOCKER_BAND = (configuration("build")["terrain"]["moverBlockerClearanceLow"],
                configuration("build")["terrain"]["moverBlockerClearanceHigh"])
OVERLAY_OFFSET = configuration("build")["terrain"]["overlayOffset"]
AREA_TOLERANCE = 1e-7


class Mesh:
    def __init__(self):
        self.positions, self.normals, self.indices = [], [], []

    def add(self, polygon, plane, offset=0):
        if polygon.is_empty:
            return
        faces = shapely.get_parts(shapely.constrained_delaunay_triangles(polygon))
        area = sum(face.area for face in faces)
        if abs(area - polygon.area) > AREA_TOLERANCE * max(1, polygon.area):
            raise ValueError("Collision polygon triangulation lost area")
        normal = plane[:3] / np.linalg.norm(plane[:3])
        for face in faces:
            points = np.array(face.exterior.coords)[:3]
            u, v = points[1] - points[0], points[2] - points[0]
            if u[0] * v[1] - u[1] * v[0] < 0:
                points = points[::-1]
            for x, y in points:
                self.indices.append(len(self.positions) // 3)
                self.positions.extend((float(x), float(y), float(-plane[0] * x - plane[1] * y - plane[3] + offset)))
                self.normals.extend(normal.tolist())

    def conform(self):
        """Make the mesh conforming (see conforming); every triangle keeps its own three vertices."""
        tris = conforming(np.array(self.positions, float).reshape(-1, 3, 3))
        normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        length = np.linalg.norm(normals, axis=1)
        tris, normals = tris[length > 0], normals[length > 0] / length[length > 0, None]   # no surface: dropped
        self.positions = tris.reshape(-1).tolist()
        self.normals = np.repeat(normals, 3, axis=0).reshape(-1).tolist()
        self.indices = list(range(len(tris) * 3))

    def data(self):
        return {"positions": self.positions, "normals": self.normals, "indices": self.indices}


WELD = 1e-3   # m; vertices this close are one point (the welding of Nav vertices in reachability)


def conforming(tris):
    """Triangles (k, 3, 3) that meet edge to edge. Vertices are snapped to WELD; triangles thinner than WELD (carving
    leaves slivers along cut lines) hold no surface and are dropped; a vertex lying inside another triangle's edge is
    inserted into that edge, and the triangle is fanned from its centroid. Carving triangulates each Nav triangle on
    its own, so cut points on an original edge otherwise appear on one side only (T-junctions)."""
    tris = np.round(tris / WELD) * WELD
    double_area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1)
    longest = np.linalg.norm(tris - np.roll(tris, 1, axis=1), axis=2).max(1)
    tris = tris[double_area > WELD * longest]          # height over the longest edge at least WELD
    points = np.unique(tris.reshape(-1, 3), axis=0)
    tree = cKDTree(points[:, :2])
    out = []
    for tri in tris:
        ring = []
        for a, b in zip(tri, np.roll(tri, -1, axis=0)):
            ring.append(a)
            d = b - a
            length = np.linalg.norm(d[:2])
            near = points[tree.query_ball_point((a[:2] + b[:2]) / 2, length / 2 + WELD)]
            t = (near[:, :2] - a[:2]) @ d[:2] / length ** 2
            off = np.abs((near[:, 0] - a[0]) * d[1] - (near[:, 1] - a[1]) * d[0]) / length
            on = ((t * length > WELD) & ((1 - t) * length > WELD) & (off < WELD)
                  & (np.abs(near[:, 2] - a[2] - t * d[2]) < 2 * WELD))
            ring.extend(near[on][np.argsort(t[on])])
        if len(ring) == 3:
            out.append(tri)
            continue
        ring = np.array(ring)
        centre = np.repeat(tri.mean(0)[None], len(ring), axis=0)
        out.extend(np.stack([centre, ring, np.roll(ring, -1, axis=0)], axis=1))
    return np.array(out).reshape(-1, 3, 3)


def blocker_shapes(blockers):
    """player_mover_blocker meshes ({"name", "triangles"}, open ones marked "surface") as carving shapes with their
    own band: closed meshes as solids, open ones as surfaces."""
    shapes = []
    for blocker in blockers:
        triangles = np.asarray(blocker["triangles"], dtype=float).reshape(-1, 3, 3)
        if len(triangles):
            shapes.append({"triangles": triangles, "convex": False, "surface_only": blocker.get("surface", False),
                           "band": BLOCKER_BAND,
                           "source": {"volume": blocker["name"], "level": blocker["level"]},
                           "low": triangles.min(axis=(0, 1)), "high": triangles.max(axis=(0, 1))})
    return shapes


def source_key(source):
    return tuple(source.get("ancestry", ())), source.get("unit")


EDGE_STEP = 0.1        # m; samples along a shared Nav edge for the connectivity of carved Nav
NAV_SNAP = 2.0         # m; a point (link end, spawner, main path point) belongs to a Nav triangle this far below
BODY_CLEARANCE = 0.45  # m; an edge connects where some point keeps a body radius from carved Nav (player 0.495)
LEVEL_DZ = 1.0         # m; carved Nav of another floor (above or below) does not narrow an edge


def points_of(value):
    """All [x, y, z] number triples nested anywhere in value (main path data)."""
    if isinstance(value, (list, tuple)) and len(value) == 3 and all(isinstance(v, (int, float)) for v in value):
        return [value]
    if isinstance(value, dict):
        value = list(value.values())
    if isinstance(value, (list, tuple)):
        return [point for item in value for point in points_of(item)]
    return []


def reopen_monster_walls(mission, points, triangles, results, scene, main_path, nav_surface):
    """Unit keys (walls and their panels) of sealed monster walls that a boss does break.

    The carved Nav splits into connected parts (a shared edge connects where some point of it keeps a body radius
    from carved Nav, as the player needs to pass). When
    one end of a wall's monster link lies in a part that is off the main path and holds a MonsterSpawner, a boss
    spawns in the closed-off area and breaks out through the wall."""
    walls = {(tuple(u["ancestry"]), u["unit"]): u["monster_wall"]["links"] for u in scene if u.get("monster_wall")}
    if not walls:
        return set()
    tri = np.asarray([t[:3] for t in triangles]) - 1
    parent = list(range(len(tri)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    centers = points[tri].mean(1)
    carved = [index for index, result in enumerate(results) if not result[2].is_empty]
    carved_tree = shapely.STRtree([results[index][2] for index in carved]) if carved else None
    edges = {}
    for index, (a, b, c) in enumerate(tri):
        for e in ((a, b), (b, c), (c, a)):
            edges.setdefault(tuple(sorted(e)), []).append(index)
    for (a, b), owners in edges.items():
        if len(owners) != 2:
            continue
        i, j = owners
        if find(i) == find(j):
            continue
        if carved_tree is not None:
            line = shapely.LineString([points[a][:2], points[b][:2]])
            z = (points[a][2] + points[b][2]) / 2
            near = [carved[k] for k in carved_tree.query(line, predicate="dwithin", distance=BODY_CLEARANCE)
                    if abs(centers[carved[k]][2] - z) <= LEVEL_DZ]
            if near:
                cut = shapely.union_all([results[k][2] for k in near])
                pa, pb = points[a][:2], points[b][:2]
                n = max(int(np.linalg.norm(pb - pa) / EDGE_STEP), 2)
                samples = shapely.points(pa + (pb - pa) * (np.arange(1, n) / n)[:, None])
                if shapely.dwithin(cut, samples, BODY_CLEARANCE).all():
                    continue      # no point of the edge leaves room for a body: closed here
        parent[find(i)] = find(j)

    def part(point):
        point = np.asarray(point, float)
        best = None
        for t in nav_surface.tree.query(shapely.Point(point[:2]), predicate="intersects"):
            dz = point[2] - centers[t][2]
            if -0.5 <= dz <= NAV_SNAP and (best is None or abs(dz) < best[0]):
                best = (abs(dz), t)
        return None if best is None else find(best[1])
    main = {part(p) for p in points_of(main_path or [])[::4]} - {None}
    spawners = Counter(part(u["position"]) for u in scene
                       if any(c["name"] == "MonsterSpawner" for c in u["components"]))
    opened = set()
    for key, links in walls.items():
        ends = {part(end) for link in links for end in link} - {None}
        if any(e not in main and spawners[e] for e in ends):
            opened.add(key)
    if not opened:
        return set()
    panels = {(tuple(u["ancestry"]), u["unit"]) for u in scene
              if any((tuple(w[0]), w[1]) in opened for w in u.get("monster_wall_panel_of", ()))}
    print(f"{mission}: re-opened {len(opened)} monster walls with a MonsterSpawner behind them", flush=True)
    return opened | panels


def carve(mission, nav, scene, assets, blockers=(), main_path=None):
    started = time.monotonic()
    points = np.array(nav["vertices"])
    top = max(CLEARANCE_HIGH, BLOCKER_BAND[1])
    bounds = np.array(nav["bounds"]["min"]), np.array(nav["bounds"]["max"]) + [0, 0, top]
    counts = Counter()
    shapes = assets.place(scene, bounds, counts)
    extra = blocker_shapes(blockers)
    counts["mover_blocker_shapes"] += len(extra)
    shapes.extend(extra)
    print(f"{mission}: {len(shapes)} indexed collision shapes", flush=True)
    low = np.array([shape["low"] for shape in shapes])
    high = np.array([shape["high"] for shape in shapes])
    footprints = shapely.box(low[:, 0], low[:, 1], high[:, 0], high[:, 1])
    band = np.array([shape.get("band", (CLEARANCE_LOW, CLEARANCE_HIGH)) for shape in shapes])
    band_low, band_high = band[:, 0], band[:, 1]
    for index, shape in enumerate(shapes):
        if shape.get("surface_only"):
            # Rotated heightfield strips have very loose axis-aligned bounds.
            footprints[index] = shapely.convex_hull(shapely.multipoints(shape["triangles"].reshape(-1, 3)[:, :2]))
    tree = shapely.STRtree(footprints)
    # real floor for the walkable-surface correction (ground.py): level collision only, no mover blockers
    nav_surface = NavSurface(points, nav["triangles"])
    floor_rays, floor_sources = floor_queries(shapes, nav_surface, CLEARANCE_LOW)
    solid_cache = {}
    triangles_in = nav["triangles"]

    def carve_one(index, skip=frozenset()):
        """(plane, remaining, removed, sources, walkable area, area error) of Nav triangle index; skip: unit keys
        whose shapes no longer count (monster walls re-opened below)."""
        vertices = points[np.array(triangles_in[index][:3]) - 1]
        normal = np.cross(vertices[1] - vertices[0], vertices[2] - vertices[0])
        if abs(normal[2]) < 1e-10:
            raise ValueError(f"{mission}: vertical or degenerate Nav triangle {index}")
        plane = np.r_[normal / normal[2], -np.dot(normal, vertices[0]) / normal[2]]
        subject = shapely.Polygon(vertices[:, :2])
        candidates = tree.query(subject, predicate="intersects")
        candidates = candidates[(high[candidates, 2] > vertices[:, 2].min() + band_low[candidates])
                                & (low[candidates, 2] < vertices[:, 2].max() + band_high[candidates])]
        cutters, sources, blocker_cutters, solids = [], [], [], []
        for candidate in candidates:
            shape = shapes[candidate]
            if skip and source_key(shape["source"]) in skip:
                continue
            cut = project_shape(shape, plane, band_low[candidate], band_high[candidate], subject.bounds)
            if cut.is_empty or cut.area <= AREA_EPSILON:
                continue
            cut = cut.intersection(subject)
            if cut.area <= AREA_EPSILON:
                continue
            if "volume" in shape["source"]:
                blocker_cutters.append(cut)
            else:
                cutters.append(cut)
                if shape.get("triangles") is None:      # closed convex or curved solid
                    if candidate not in solid_cache:
                        solid_cache[candidate] = shape_triangles(shape)
                    solids.append(solid_cache[candidate])
            sources.append(shape["source"])
        removed = shapely.union_all(cutters)
        walkable = shapely.Polygon()
        if not removed.is_empty:   # floor that the Nav plane misjudges as an obstacle (stairs, ramps, slabs)
            walkable = walkable_cut(removed, plane, subject, floor_rays, nav_surface, CLEARANCE_LOW, CLEARANCE_HIGH,
                                    solids, surfaces=floor_sources)
            if not walkable.is_empty:
                removed = shapely.difference(removed, walkable)
        removed = shapely.union_all([removed, *blocker_cutters])
        remaining = shapely.difference(subject, removed)
        error = abs(subject.area - remaining.area - removed.area)
        if error > AREA_TOLERANCE * max(1, subject.area):
            raise ValueError(f"{mission}: terrain area mismatch at Nav triangle {index}: {error}")
        return plane, remaining, removed, sources, shapely.intersection(walkable, remaining), error

    results = [carve_one(index) for index in range(len(triangles_in))]
    reopened = reopen_monster_walls(mission, points, triangles_in, results, scene, main_path, nav_surface)
    if reopened:
        for index, result in enumerate(results):
            if any(source_key(source) in reopened for source in result[3]):
                results[index] = carve_one(index, reopened)
    counts["reopened_monster_wall_units"] = len(reopened)
    kept, red, raised = Mesh(), Mesh(), Mesh()
    provenance = []
    removed_area = kept_area = walkable_area = 0
    maximum_error = 0
    for index, (plane, remaining, removed, sources, walkable, error) in enumerate(results):
        walkable_area += walkable.area
        maximum_error = max(maximum_error, error)
        kept_area += remaining.area
        removed_area += removed.area
        # raised floor and Nav-level floor are triangulated apart: no triangle spans the step between them
        kept.add(shapely.difference(remaining, walkable), plane)
        kept.add(walkable, plane)
        red.add(removed, plane, OVERLAY_OFFSET)
        raised.add(walkable, plane)
        if sources:
            provenance.append({"triangle": index, "sources": sources})
    kept.conform()
    red.conform()
    vertices = [kept.positions[index:index + 3] for index in range(0, len(kept.positions), 3)]
    triangles = [list(range(index + 1, index + 4)) for index in range(0, len(kept.indices), 3)]
    stats = {"inputTriangles": len(nav["triangles"]), "outputTriangles": len(triangles),
             "redTriangles": len(red.indices) // 3,
             "removedArea": removed_area, "keptArea": kept_area,
             "maxAreaError": maximum_error, "shapeCounts": dict(counts), "walkableArea": walkable_area,
             "elapsedSeconds": time.monotonic() - started}
    metadata = {"schema_version": 1, "mission": mission, "detection": "offline-solid-clearance-v1",
                "clearance": [CLEARANCE_LOW, CLEARANCE_HIGH], "curve_error": CURVE_ERROR,
                "overlay_offset": OVERLAY_OFFSET,
                "complete": True}
    return {"schema_version": 1, "mission": mission, "navmesh": {**nav, "vertices": vertices, "triangles": triangles,
             "stats": {**nav["stats"], "vertices": len(vertices), "triangles": len(triangles)}},
            "removedMesh": red.data(), "stats": stats, "data": metadata,
            # kept Nav whose real floor is raised above the Nav plane (walkable_cut), on the Nav plane
            "raisedMesh": raised.data(),
            "provenance": provenance}


def build_mission(mission, root):
    path = root / "missions" / f"{mission}.json"
    packet = json.loads(path.read_text(encoding="utf-8"))
    result = carve(mission, packet["navmesh"], packet["scene"], CollisionAssets(root, mission),
                   packet.get("moverBlockers", ()), packet.get("mainPath"))
    packet["terrain"] = result
    path.write_text(json.dumps(packet, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"mission": mission, **result["stats"]}


def build_terrain(root, missions, workers):
    with ProcessPoolExecutor(max_workers=workers) as pool:
        pending = [pool.submit(build_mission, mission, root) for mission in missions]
        reports = {}
        for future in as_completed(pending):
            report = future.result()
            reports[report["mission"]] = report
            print(json.dumps(report), flush=True)
    return [reports[mission] for mission in missions]
