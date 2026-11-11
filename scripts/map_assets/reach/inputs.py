"""Collision and gameplay inputs of reachability, from a mission packet and the build's collision catalog."""

from collections import Counter

import numpy as np
import shapely
from shapely.geometry import Polygon

from ..formats.level import key32
from ..formats.unit_geometry import node_matrices
from ..terrain.ground import shape_triangles

# actors players stand on but that are no permanent wall: moving or Flow-controlled (platforms, lifts, gates that
# open); they count as floor in every pose they are placed in
SUPPORT_ONLY = {"non_static_actor", "flow_controlled_actor"}
HANG_FILTER = "filter_hang_ledge_collision"
EMPTY = np.zeros((0, 3, 3))


def triangles(shapes):
    return np.concatenate([shape_triangles(shape) for shape in shapes]) if shapes else EMPTY


def collision_sets(assets, scene, bounds):
    """(blocking, support, envelopes): blocking = permanent player-mover collision; support = blocking plus moving
    and Flow-controlled actors at their placed pose and at every story key pose, for standing only; envelopes =
    (pivot, radius) of the space those units sweep about their placed pose (nav there may be held by them in another
    pose)."""
    moved = [{**unit, "transform": pose, "story_pose": k} for unit in scene
             for k, pose in enumerate(unit.get("story_poses", ()))]
    shapes = assets.place(scene + moved, bounds, Counter(), keep_rejected=True)
    units = {(unit["unit"], tuple(unit["ancestry"])): unit for unit in scene}
    blocking, support, envelopes = [], [], {}
    for shape in shapes:
        if shape["rejected"] is not None and shape["rejected"] not in SUPPORT_ONLY:
            continue
        support.append(shape)
        if "storyPose" in shape["source"]:
            continue
        if shape["rejected"] is None:
            blocking.append(shape)
            continue
        source = shape["source"]; key = (source["unit"], tuple(source["ancestry"]))
        pivot = np.asarray(units[key]["position"], float)
        corners = np.array([[x, y, z] for x in (shape["low"][0], shape["high"][0])
                            for y in (shape["low"][1], shape["high"][1]) for z in (shape["low"][2], shape["high"][2])])
        radius = float(np.linalg.norm(corners - pivot, axis=1).max())
        envelopes[key] = (pivot, max(radius, envelopes.get(key, (pivot, 0.0))[1]))
    return triangles(blocking), triangles(support), list(envelopes.values())


def hang_ledges(assets, scene, bounds):
    """Hang-ledge collision: a falling body passing it catches the ledge instead of landing."""
    return triangles(assets.place(scene, bounds, Counter(), query_filter=HANG_FILTER, query_shapes=True))


def volume_triangles(volumes):
    return np.concatenate([np.asarray(v["triangles"], float).reshape(-1, 3, 3) for v in volumes]) if volumes else EMPTY


def ladders(assets, scene):
    """(bottom, top) world points of every Ladder component (climbable both ways)."""
    out = []
    for unit in scene:
        if not any(c["name"] == "Ladder" for c in unit["components"]) or unit["resource"] not in assets.units:
            continue
        graph, _ = assets.geometry(unit["resource"])
        nodes = node_matrices(graph, unit["node_overrides"]); matrix = np.array(unit["transform"])
        names = [key32(name) for name in ("node_bottom", "node_leave")]
        if all(name in nodes for name in names):
            out.append(tuple((matrix @ nodes[name])[:3, 3] for name in names))
    return out


def nav_contacts(nav_tris, pose, volume):
    """Points of nav inside an authored extruded polygon volume placed at pose (one per touching nav piece)."""
    polygon = Polygon(volume["polygon"])
    caps = list(shapely.get_parts(shapely.constrained_delaunay_triangles(polygon)))
    low, high = np.asarray(volume["bounds"], float)
    inverse = np.linalg.inv(pose)
    local = nav_tris @ inverse[:3, :3].T + inverse[:3, 3]
    candidates = np.flatnonzero(np.all(local.max(axis=1) >= low, axis=1) & np.all(local.min(axis=1) <= high, axis=1))
    contacts = []
    for index in candidates:
        for cap in caps:
            piece = clip_prism(local[index], np.asarray(cap.exterior.coords)[:3], low[2], high[2])
            if piece:
                contacts.append((pose @ np.r_[np.mean(piece, axis=0), 1])[:3])
    return contacts


def clip_prism(points, corners, low, high):
    """Triangle points clipped to the vertical prism over a 2D triangle between heights low and high."""
    a, b = corners[1] - corners[0], corners[2] - corners[0]
    sign = 1 if a[0] * b[1] - a[1] * b[0] > 0 else -1
    planes = [(np.array([0, 0, 1.0]), low), (np.array([0, 0, -1.0]), -high)]
    for p, q in zip(corners, np.roll(corners, -1, axis=0)):
        normal = np.array([p[1] - q[1], q[0] - p[0], 0]) * sign
        planes.append((normal, normal[:2] @ p))
    points = list(points)
    for normal, bound in planes:
        clipped = []
        for p, q in zip(points, points[1:] + points[:1]):
            dp, dq = normal @ p - bound, normal @ q - bound
            if dp >= 0:
                clipped.append(p)
            if (dp < 0) != (dq < 0):
                clipped.append(p + (q - p) * dp / (dp - dq))
        points = clipped
        if not points:
            break
    return points


def platform_docks(platforms, nav_tris):
    """Per player platform, per dock: (dock position, world points where players board at that dock)."""
    out = []
    for platform in platforms:
        docks = []
        for dock in platform["docks"]:
            pose = np.array(dock["transform"])
            if platform["gate"]:
                points = nav_contacts(nav_tris, pose, platform["gate"])
            else:
                points = [(pose @ np.r_[p, 1])[:3] for p in platform["boarding"]]
            docks.append((pose[:3, 3], points))
        out.append(docks)
    return out
