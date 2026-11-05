"""Place authored collision shapes and classify them by static resource semantics."""

import json
from functools import lru_cache
from itertools import product

import numpy as np
from scipy.spatial import ConvexHull
from scipy.spatial.transform import Rotation

from ..formats.unit_geometry import ACTOR_CREATE_ON_SPAWN_INDEX, ActorWorld, node_matrices
from ..formats.physics import ACTOR_TEMPLATE_FLAGS_INDEX, ActorTemplateFlag, ShapeTemplateFlag
from ..formats.collision_geometry import (
    CollisionShape, HEIGHTFIELD_HOLE_MATERIAL, HEIGHTFIELD_MATERIAL_MASK, HEIGHTFIELD_TESSELLATION_FLAG,
)
from ..config import configuration

BUILD_CONFIG = configuration("build")
CURVE_ERROR = BUILD_CONFIG["terrain"]["curveError"]
HEIGHTFIELD_CHUNK = BUILD_CONFIG["terrain"]["heightfieldChunk"]
EXCLUDED_UNIT_RESOURCES = BUILD_CONFIG["collision"]["excludedResources"]
NON_COLLIDING_SHAPE_FLAGS = ShapeTemplateFlag.DISABLE_COLLISION | ShapeTemplateFlag.TRIGGER
BOX_VERTICES = np.array(list(product((-1, 1), repeat=3)), dtype=float)
BOX_EDGES = np.array([(a, b) for a in range(8) for b in range(a + 1, 8)
                      if np.count_nonzero(BOX_VERTICES[a] != BOX_VERTICES[b]) == 1])


def json_file(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rigid_matrix(matrix):
    scale = np.linalg.norm(matrix[:3, :3], axis=0)
    if np.any(scale == 0):
        raise ValueError("Zero-scale collision actor")
    if np.linalg.det(matrix[:3, :3]) < 0:
        scale = -scale
    rotation = Rotation.from_matrix(matrix[:3, :3] / scale).as_matrix()
    return rotation, scale


def shape_placement(actor_pose, local_matrix):
    actor_rotation, scale, actor_position = actor_pose
    shape_rotation = Rotation.from_matrix(local_matrix[:3, :3]).as_matrix()
    shape_scale = np.linalg.norm(scale[:, None] * shape_rotation, axis=0)
    if np.prod(scale) < 0:
        shape_scale = -shape_scale
    rotation = actor_rotation @ shape_rotation
    position = actor_position + actor_rotation @ (scale * local_matrix[:3, 3])
    return rotation, position, shape_scale


def curve_dimensions(kind, parameters, scale):
    radius = parameters[0]
    if kind == CollisionShape.SPHERE:
        radius *= np.mean(np.abs(scale))
        height = 0
    else:
        radius *= (abs(scale[1]) + abs(scale[2])) / 2
        height = max(0, (2 * parameters[0] + parameters[1]) * abs(scale[0]) - 2 * radius)
    if radius <= 0:
        raise ValueError("Non-positive collision sphere/capsule radius")
    return radius, height


@lru_cache(maxsize=2048)
def curved_shape(kind, parameters, scale):
    radius, height = curve_dimensions(kind, parameters, scale)
    steps = max(8, int(np.ceil(np.pi / np.arccos(1 - min(CURVE_ERROR / radius, 1)))))
    angles = np.linspace(0, 2 * np.pi, steps, endpoint=False)
    half = np.linspace(0, np.pi / 2, max(3, (steps + 3) // 4))
    rings = [(angle, height / 2) for angle in half]
    rings += [(angle + np.pi / 2, -height / 2) for angle in half]
    latitude = np.array([angle for angle, _ in rings])[:, None]
    offset = np.array([offset for _, offset in rings])[:, None]
    radial = radius * np.sin(latitude)
    vertices = np.stack((np.broadcast_to(offset + radius * np.cos(latitude), (len(rings), steps)),
                         radial * np.cos(angles), radial * np.sin(angles)), axis=-1).reshape(-1, 3)
    faces = ConvexHull(vertices).simplices
    edges = np.unique(np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1), axis=0)
    return vertices, edges


def heightfield(shape, samples):
    rows, columns, height_scale, row_scale, column_scale, _ = shape["parameters"]
    row, column = np.indices((rows, columns))
    vertices = np.stack((row * row_scale, samples["height"] * height_scale, column * column_scale), axis=-1).reshape(-1, 3)
    cells = (row[:-1, :-1] * columns + column[:-1, :-1]).ravel()
    split = (samples["material0"][:-1, :-1].ravel() & HEIGHTFIELD_TESSELLATION_FLAG) != 0
    first = np.stack((cells, cells + 1, cells + columns), axis=1)
    second = np.stack((cells + columns + 1, cells + columns, cells + 1), axis=1)
    first[split] = np.stack((cells[split] + columns, cells[split], cells[split] + columns + 1), axis=1)
    second[split] = np.stack((cells[split] + 1, cells[split] + columns + 1, cells[split]), axis=1)
    valid0 = (samples["material0"][:-1, :-1].ravel() & HEIGHTFIELD_MATERIAL_MASK) != HEIGHTFIELD_HOLE_MATERIAL
    valid1 = (samples["material1"][:-1, :-1].ravel() & HEIGHTFIELD_MATERIAL_MASK) != HEIGHTFIELD_HOLE_MATERIAL
    return vertices, np.concatenate((first[valid0], second[valid1]))


def obstacle_rejection(unit, actor, physics):
    if actor["name"] in unit["conditional_actors"]:
        return "flow_controlled_actor"
    if physics["actors"][str(actor["template"])][ACTOR_TEMPLATE_FLAGS_INDEX] & ActorTemplateFlag.DYNAMIC:
        return "non_static_actor"
    if unit["resource"] in EXCLUDED_UNIT_RESOURCES:
        return EXCLUDED_UNIT_RESOURCES[unit["resource"]]
    return None


class CollisionAssets:
    def __init__(self, root, mission):
        self.root = root
        self.units = json_file(root / "collision_units.json")
        self.physics = json_file(root / "physics.json")
        self.cache = {}
        self.actor_exclusions = {}
        for rule in BUILD_CONFIG["collision"]["nonObstacleActors"].get(mission, []):
            key = tuple(rule["ancestry"]), rule["unit"], rule["actor"]
            if key in self.actor_exclusions or not rule["reason"]:
                raise ValueError(f"Invalid or duplicate non-obstacle actor rule: {rule}")
            self.actor_exclusions[key] = rule

    def validate_actor_exclusions(self, scene):
        if not self.actor_exclusions:
            return
        instances = {(tuple(unit["ancestry"]), unit["unit"]): unit for unit in scene}
        for (ancestry, identity, actor), rule in self.actor_exclusions.items():
            unit = instances.get((ancestry, identity))
            if unit is None or unit["resource"] != rule["resource"]:
                raise ValueError(f"Non-obstacle actor rule no longer matches its instance: {rule}")
            if actor not in {item["name"] for item in self.units[unit["resource"]]["actors"]}:
                raise ValueError(f"Non-obstacle actor rule references a missing actor: {rule}")

    def geometry(self, identity):
        if identity not in self.cache:
            unit = self.units[identity]
            arrays = {}
            if any(s["arrays"] for a in unit["actors"] for s in a["shapes"]):
                with np.load(self.root / "collision_geometry" / f"{identity}.npz", allow_pickle=False) as store:
                    arrays = {key: store[key] for key in store.files}
            graph = {field: {node["name"]: np.array(node[key]) for node in unit["nodes"]}
                     for field, key in [("nodes", "world"), ("local_nodes", "local"), ("parents", "parent")]}
            shapes = {}
            for a, actor in enumerate(unit["actors"]):
                for s, shape in enumerate(actor["shapes"]):
                    keys = shape["arrays"]
                    if shape["type"] in (CollisionShape.TRIANGLE_MESH, CollisionShape.CONVEX_MESH):
                        points, faces = arrays[keys["vertices"]], arrays[keys["triangles"]]
                        edges = np.unique(np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1), axis=0)
                        shapes[a, s] = points, faces, edges
                    elif shape["type"] == CollisionShape.HEIGHTFIELD:
                        points, faces = heightfield(shape, arrays[keys["samples"]])
                        shapes[a, s] = points, faces, None
            self.cache[identity] = graph, shapes
        return self.cache[identity]

    def place(self, scene, bounds, counts):
        self.validate_actor_exclusions(scene)
        result = []
        for unit in scene:
            if unit["physics_disabled"] or unit.get("mission_path_blocker_enabled") is False:
                continue
            identity = unit["resource"]
            if identity not in self.units:
                continue
            graph, shapes = self.geometry(identity)
            nodes = node_matrices(graph, unit["node_overrides"])
            for a, actor in enumerate(self.units[identity]["actors"]):
                if (actor["resource_group"] != ActorWorld.PRIMARY
                        or (not actor["flags"][ACTOR_CREATE_ON_SPAWN_INDEX] and not unit["create_actors"])):
                    continue
                actor_matrix = np.array(unit["transform"]) @ nodes[actor["node"]]
                planar_rank = np.linalg.matrix_rank(actor_matrix[:2, :3])
                actor_pose = None
                rule = self.actor_exclusions.get((tuple(unit["ancestry"]), unit["unit"], actor["name"]))
                reason = rule["reason"] if rule else obstacle_rejection(unit, actor, self.physics)
                for s, shape in enumerate(actor["shapes"]):
                    profile = self.physics["shapes"][str(shape["template"])]
                    if not profile["matches_player_mover_filter"] or profile["flags"] & NON_COLLIDING_SHAPE_FLAGS:
                        continue
                    if reason:
                        counts[f"rejected_{reason}"] += 1
                        continue
                    # Collapsed linear geometry cannot remove an area from the Nav plane.
                    if shape["type"] not in (CollisionShape.SPHERE, CollisionShape.CAPSULE) and planar_rank < 2:
                        counts["zero_area_shapes"] += 1
                        continue
                    if actor_pose is None:
                        rotation, scale = rigid_matrix(actor_matrix)
                        actor_pose = rotation, scale, actor_matrix[:3, 3]
                    rotation, position, scale = shape_placement(actor_pose, np.array(shape["transform"]))
                    kind = shape["type"]
                    curve = None
                    if kind == CollisionShape.BOX:
                        points, edges, faces = BOX_VERTICES * shape["parameters"] * scale, BOX_EDGES, None
                    elif kind in (CollisionShape.SPHERE, CollisionShape.CAPSULE):
                        curve = kind, tuple(shape["parameters"]), tuple(scale)
                        radius, height = curve_dimensions(*curve)
                        extent = radius + np.abs(rotation[:, 0]) * height / 2
                        low, high = position - extent, position + extent
                    else:
                        points, faces, edges = shapes[a, s]
                        points = points * scale
                    if curve is None:
                        points = points @ rotation.T + position
                        low, high = points.min(axis=0), points.max(axis=0)
                    if np.any(high < bounds[0]) or np.any(low > bounds[1]):
                        continue
                    counts["static_obstacle_shapes"] += 1
                    source = {"resource": identity, "unit": unit["unit"], "ancestry": unit["ancestry"],
                              "actor": a, "shape": s}
                    if curve is not None:
                        result.append({"curve": curve, "rotation": rotation, "position": position,
                                       "radius": radius, "half_height": height / 2, "convex": True,
                                       "source": source, "low": low, "high": high})
                    elif kind == CollisionShape.HEIGHTFIELD:
                        for start in range(0, len(faces), HEIGHTFIELD_CHUNK):
                            triangles = points[faces[start:start + HEIGHTFIELD_CHUNK]]
                            result.append({"triangles": triangles, "convex": False, "source": source,
                                           "low": triangles.min(axis=(0, 1)), "high": triangles.max(axis=(0, 1)), "surface_only": True})
                    else:
                        result.append({"vertices": points, "edges": edges, "convex": kind != CollisionShape.TRIANGLE_MESH, "source": source,
                                       "triangles": points[faces] if faces is not None and kind == CollisionShape.TRIANGLE_MESH else None,
                                       "low": low, "high": high, "surface_only": False})
        return result
