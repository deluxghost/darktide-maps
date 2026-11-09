"""World-space level volumes.

Levels store their authored volumes natively (polygon footprint, height range, cap triangulation and pose); the
volume type lives in the level's `<level>_volume_data` Lua metadata, matched by name hash, for the levels whose
mission package loads that Lua. player_mover_blocker volumes are carried as closed prisms for terrain carving;
player_instakill volumes kill a player entering them, and reachability rejects moves through them.

player_mover_blocker volumes are also compiled into the collision of the level itself (unit data embedded in the
level resource), which stops the player mover whether or not the volume Lua is loaded: reachability takes its
walls from that collision (level_blockers); where the Lua is not loaded, carving takes its connected parts
(solid_parts), closed ones as solids and open ones as surfaces.
"""

from collections import Counter

import numpy as np

from ..formats.binary import resource
from ..formats.level import key32
from ..formats.resource import murmur64
from ..terrain.ground import shape_triangles
from .objects import walk_levels

PLAYER_INSTAKILL = "content/volume_types/player_instakill"
MOVER_BLOCKER = "content/volume_types/player_mover_blocker"
VOLUME_TABLE_OFFSET = 96
RECORD_NAME, RECORD_BOUNDS, RECORD_CAPS, RECORD_VERTICES, RECORD_POLYGON = 28, 4, 36, 56, 64
CAP_STRIDE, CAP_INDICES = 16, 4
POSE_STRIDE = 128


def native_volumes(path):
    """Native volumes of one level resource: name hash, local polygon, z range, cap triangles and pose."""
    _, reader = resource(path, murmur64("level"))
    count, start, poses = reader.unpack("<3I", VOLUME_TABLE_OFFSET)
    result, offset = [], start
    for index in range(count):
        bounds = reader.unpack("<6f", offset + RECORD_BOUNDS)
        name, = reader.unpack("<I", offset + RECORD_NAME)
        vertices, stride = reader.unpack("<2I", offset + RECORD_VERTICES)
        if stride < RECORD_POLYGON or RECORD_POLYGON + vertices * 8 > stride or offset + stride > poses:
            raise ValueError(f"{reader.name}: invalid native volume record {index}")
        polygon = np.array([reader.unpack("<2f", offset + RECORD_POLYGON + i * 8) for i in range(vertices)])
        cap_count, cap_offset = reader.unpack("<2I", offset + RECORD_CAPS)
        caps = np.array([reader.unpack("<3I", offset + cap_offset + i * CAP_STRIDE + CAP_INDICES)
                         for i in range(cap_count)], dtype=int).reshape(-1, 3)
        if len(caps) and caps.max() >= vertices:
            raise ValueError(f"{reader.name}: invalid native volume cap triangle {index}")
        pose = np.array(reader.unpack("<16f", poses + index * POSE_STRIDE)).reshape((4, 4), order="F")
        if not np.isfinite(pose).all() or not np.array_equal(pose[3], [0, 0, 0, 1]):
            raise ValueError(f"{reader.name}: invalid native volume pose {index}")
        result.append({"name": name, "polygon": polygon, "z": (bounds[2], bounds[5]), "caps": caps, "pose": pose})
        offset += stride
    if offset != poses:
        raise ValueError(f"{reader.name}: native volume table size mismatch")
    return result


def prism(volume, matrix):
    """Closed, outward-facing triangle mesh of an extruded volume, in world space."""
    polygon, (low, high), caps = volume["polygon"], volume["z"], volume["caps"]
    n = len(polygon)
    x, y = polygon[:, 0], polygon[:, 1]
    ring = np.arange(n)
    if (x * np.roll(y, -1) - np.roll(x, -1) * y).sum() < 0:   # make the footprint counter-clockwise
        ring = ring[::-1]
    a, b, c = polygon[caps[:, 0]], polygon[caps[:, 1]], polygon[caps[:, 2]]
    up = ((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])) > 0
    top = np.where(up[:, None], caps, caps[:, ::-1])
    nxt = np.roll(ring, -1)
    faces = np.concatenate([top[:, ::-1], top + n, np.c_[ring, nxt, nxt + n], np.c_[ring, nxt + n, ring + n]])
    world = matrix @ volume["pose"]
    if np.linalg.det(world[:3, :3]) < 0:
        faces = faces[:, ::-1]
    local = np.concatenate([np.c_[polygon, np.full(n, low)], np.c_[polygon, np.full(n, high)]])
    points = (np.c_[local, np.ones(len(local))] @ world.T)[:, :3]
    return points[faces]


def typed_volumes(root, levels, level_paths, volume_metadata, kinds):
    """World-space prisms of every level volume of the given types, per type, for every level instance of a mission.

    level_paths: level hash -> resource path; volume_metadata: level hash -> {name hash: volume type},
    for levels whose `_volume_data` Lua is loaded by the mission package.
    """
    result = {kind: [] for kind in kinds}
    for identity, _, placement, ancestry in walk_levels(root, levels):
        types = volume_metadata.get(identity)
        if not types:
            continue
        volumes = native_volumes(level_paths[identity])
        if {volume["name"] for volume in volumes} != set(types):
            raise ValueError(f"{identity}: native volumes and Lua volume metadata differ")
        for volume in volumes:
            if types[volume["name"]] in result:
                result[types[volume["name"]]].append({"name": f"{volume['name']:08x}", "level": list(ancestry),
                                                      "triangles": np.round(prism(volume, placement), 4).tolist()})
    return result


def volume_types(records):
    """Lua `volume_data` records -> {name hash: type}."""
    return {key32(record["name"]): record["type"] for record in records}


def level_blockers(root, levels, level_units, assets):
    """player_mover_blocker solids of a mission ({"name", "level", "triangles"}): the player-mover collision compiled
    into every level instance. level_units: level hash -> [(catalog key, unit data)]."""
    instances = [{"unit": key, "resource": key, "ancestry": list(ancestry), "transform": placement.tolist(),
                  "node_overrides": [], "physics_disabled": False, "create_actors": False, "conditional_actors": []}
                 for identity, _, placement, ancestry in walk_levels(root, levels) for key, _ in level_units.get(identity, ())]
    everywhere = np.full(3, -np.inf), np.full(3, np.inf)
    return [{"name": f"{shape['source']['unit']}/{shape['source']['actor']}/{shape['source']['shape']}",
             "level": shape["source"]["ancestry"], "levelResource": shape["source"]["unit"].split("-")[0],
             "triangles": np.round(shape_triangles(shape), 4).tolist()}
            for shape in assets.place(instances, everywhere, Counter())]


def solid_parts(blocker):
    """Connected parts of a compiled blocker mesh ({"name", "level", "triangles"}), each with "surface" set unless it
    is closed (every edge shared by exactly two of its triangles)."""
    tris = np.asarray(blocker["triangles"], float).reshape(-1, 3, 3)
    _, vertex = np.unique(np.round(tris.reshape(-1, 3), 3), axis=0, return_inverse=True)
    faces = vertex.reshape(-1, 3)
    edges = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    owner = np.tile(np.arange(len(faces)), 3)
    _, edge, uses = np.unique(edges, axis=0, return_inverse=True, return_counts=True)
    parent = np.arange(len(faces))

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    first = {}
    for e, f in zip(edge, owner):
        parent[root(f)] = root(first.setdefault(e, f))
    part = np.array([root(f) for f in range(len(faces))])
    result = []
    for k, label in enumerate(np.unique(part)):
        members = part == label
        closed = bool((uses[edge[np.tile(members, 3)]] == 2).all())
        result.append({"name": f"{blocker['name']}/{k}", "level": blocker["level"], "surface": not closed,
                       "triangles": tris[members].tolist()})
    return result
