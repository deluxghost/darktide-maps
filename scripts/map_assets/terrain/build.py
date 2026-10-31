"""Clip offline Nav against eligible authored solid collision shapes."""

import json
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
import shapely

from .world import CURVE_ERROR, CollisionAssets
from .sections import AREA_EPSILON, project_shape
from ..config import configuration

CLEARANCE_LOW = configuration("build")["terrain"]["clearanceLow"]
CLEARANCE_HIGH = configuration("build")["terrain"]["clearanceHigh"]
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

    def data(self):
        return {"positions": self.positions, "normals": self.normals, "indices": self.indices}


def carve(mission, nav, scene, assets):
    started = time.monotonic()
    points = np.array(nav["vertices"])
    bounds = np.array(nav["bounds"]["min"]), np.array(nav["bounds"]["max"]) + [0, 0, CLEARANCE_HIGH]
    counts = Counter()
    shapes = assets.place(scene, bounds, counts)
    print(f"{mission}: {len(shapes)} indexed collision shapes", flush=True)
    low = np.array([shape["low"] for shape in shapes])
    high = np.array([shape["high"] for shape in shapes])
    footprints = shapely.box(low[:, 0], low[:, 1], high[:, 0], high[:, 1])
    for index, shape in enumerate(shapes):
        if shape.get("surface_only"):
            # Rotated heightfield strips have very loose axis-aligned bounds.
            footprints[index] = shapely.convex_hull(shapely.multipoints(shape["triangles"].reshape(-1, 3)[:, :2]))
    tree = shapely.STRtree(footprints)
    kept, red = Mesh(), Mesh()
    provenance = []
    removed_area = kept_area = 0
    maximum_error = 0
    for index, triangle in enumerate(nav["triangles"]):
        vertices = points[np.array(triangle[:3]) - 1]
        normal = np.cross(vertices[1] - vertices[0], vertices[2] - vertices[0])
        if abs(normal[2]) < 1e-10:
            raise ValueError(f"{mission}: vertical or degenerate Nav triangle {index}")
        plane = np.r_[normal / normal[2], -np.dot(normal, vertices[0]) / normal[2]]
        subject = shapely.Polygon(vertices[:, :2])
        candidates = tree.query(subject, predicate="intersects")
        candidates = candidates[(high[candidates, 2] > vertices[:, 2].min() + CLEARANCE_LOW)
                                & (low[candidates, 2] < vertices[:, 2].max() + CLEARANCE_HIGH)]
        cutters, sources = [], []
        for candidate in candidates:
            shape = shapes[candidate]
            cut = project_shape(shape, plane, CLEARANCE_LOW, CLEARANCE_HIGH, subject.bounds)
            if cut.is_empty or cut.area <= AREA_EPSILON:
                continue
            cut = cut.intersection(subject)
            if cut.area <= AREA_EPSILON:
                continue
            cutters.append(cut)
            sources.append(shape["source"])
        removed = shapely.union_all(cutters)
        remaining = shapely.difference(subject, removed)
        error = abs(subject.area - remaining.area - removed.area)
        if error > AREA_TOLERANCE * max(1, subject.area):
            raise ValueError(f"{mission}: terrain area mismatch at Nav triangle {index}: {error}")
        maximum_error = max(maximum_error, error)
        kept_area += remaining.area
        removed_area += removed.area
        kept.add(remaining, plane)
        red.add(removed, plane, OVERLAY_OFFSET)
        if sources:
            provenance.append({"triangle": index, "sources": sources})
    vertices = [kept.positions[index:index + 3] for index in range(0, len(kept.positions), 3)]
    triangles = [list(range(index + 1, index + 4)) for index in range(0, len(kept.indices), 3)]
    stats = {"inputTriangles": len(nav["triangles"]), "outputTriangles": len(triangles),
             "redTriangles": len(red.indices) // 3,
             "removedArea": removed_area, "keptArea": kept_area,
             "maxAreaError": maximum_error, "shapeCounts": dict(counts), "elapsedSeconds": time.monotonic() - started}
    metadata = {"schema_version": 1, "mission": mission, "detection": "offline-solid-clearance-v1",
                "clearance": [CLEARANCE_LOW, CLEARANCE_HIGH], "curve_error": CURVE_ERROR,
                "overlay_offset": OVERLAY_OFFSET,
                "complete": True}
    return {"schema_version": 1, "mission": mission, "navmesh": {**nav, "vertices": vertices, "triangles": triangles,
             "stats": {**nav["stats"], "vertices": len(vertices), "triangles": len(triangles)}},
            "removedMesh": red.data(), "stats": stats, "data": metadata,
            "provenance": provenance}


def build_mission(mission, root):
    path = root / "missions" / f"{mission}.json"
    packet = json.loads(path.read_text(encoding="utf-8"))
    result = carve(mission, packet["navmesh"], packet["scene"], CollisionAssets(root, mission))
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
