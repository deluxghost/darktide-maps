"""Read unit nodes and actor shape metadata without loading render streams."""

import struct
from enum import IntEnum

import numpy as np

from .binary import resource
from .collision_geometry import CollisionShape, decode_shape
from .resource import murmur64
from ..transforms import placement_matrix
from .unit_sections import read_sections

UNIT_VERSION = 0x73
MESH_GEOMETRY_VERSION = 1
NODE_PARENT_NONE = 0
NODE_PARENT_LOCAL = 1
NODE_PARENT_EXTERNAL_MODES = {2, 3}
NODE_PARENT_MODES = {NODE_PARENT_NONE, NODE_PARENT_LOCAL, *NODE_PARENT_EXTERNAL_MODES}
ACTOR_CREATE_ON_SPAWN_INDEX = 0


class ActorWorld(IntEnum):
    PRIMARY = 0
    SECONDARY = 1


class IndexFormat(IntEnum):
    UINT16 = 0
    UINT32 = 1


INDEX_ELEMENT_BYTES = {IndexFormat.UINT16: 2, IndexFormat.UINT32: 4}


class Cursor:
    def __init__(self, reader):
        self.reader = reader
        self.offset = 0

    def read(self, layout):
        result = self.reader.unpack(layout, self.offset)
        self.offset += struct.calcsize(layout)
        return result

    def count(self):
        return self.read("<I")[0]

    def skip(self, size):
        self.reader.check(self.offset, size)
        self.offset += size

    def array(self, stride):
        count = self.count()
        self.skip(count * stride)
        return count

    def bytes(self):
        size = self.count()
        start = self.offset
        self.skip(size)
        return start, size

    def matrix(self):
        values = self.read("<16f")
        matrix = np.array(values).reshape((4, 4), order="F")
        if not np.isfinite(matrix).all() or not np.allclose(matrix[3], [0, 0, 0, 1], atol=1e-5):
            raise ValueError(f"{self.reader.name}: invalid node matrix at {self.offset - 64}")
        return matrix


def skip_mesh(cursor):
    version = cursor.count()
    if version != MESH_GEOMETRY_VERSION:
        raise ValueError(f"{cursor.reader.name}: unsupported mesh geometry version {version}")
    stream_count = cursor.count()
    for _ in range(stream_count):
        _, size = cursor.bytes()
        _, _, vertices, stride = cursor.read("<4I")
        if size not in (0, vertices * stride):
            raise ValueError(f"{cursor.reader.name}: vertex stream size mismatch")
    cursor.array(17)   # vertex channels; geometry compiled into levels has more channels than streams
    _, _, kind, count = cursor.read("<4I")
    _, size = cursor.bytes()
    if kind not in INDEX_ELEMENT_BYTES or size not in (0, count * INDEX_ELEMENT_BYTES[kind]):
        raise ValueError(f"{cursor.reader.name}: index stream size mismatch")
    cursor.array(16)
    cursor.skip(40)
    cursor.array(4)
    cursor.skip(4)


def read_nodes(cursor):
    count = cursor.count()
    local = []
    for _ in range(count):
        values = cursor.read("<15f")
        matrix = np.eye(4)
        matrix[:3, :3] = np.array(values[:9]).reshape((3, 3), order="F") @ np.diag(values[12:])
        matrix[:3, 3] = values[9:12]
        local.append(matrix)
    transforms = [cursor.matrix() for _ in range(count)]
    parents = [cursor.read("<2H") for _ in range(count)]
    names = [cursor.count() for _ in range(count)]
    cursor.array(8)
    if len(set(names)) != count:
        raise ValueError(f"{cursor.reader.name}: duplicate unit node names")
    for mode, index in parents:
        if mode not in NODE_PARENT_MODES or (mode == NODE_PARENT_LOCAL and index >= count):
            raise ValueError(f"{cursor.reader.name}: invalid node parent")
    return {"nodes": dict(zip(names, transforms, strict=True)),
            "local_nodes": dict(zip(names, local, strict=True)), "parents": dict(zip(names, parents, strict=True))}


def node_matrices(geometry, overrides):
    if not overrides:
        return geometry["nodes"]
    local = dict(geometry["local_nodes"])
    names = list(local)
    for override in overrides:
        if override["node"] not in local:
            raise ValueError(f"Unknown node override {override['node']:08x}")
        local[override["node"]] = placement_matrix(override)
    world = {}

    def resolve(name, stack=()):
        if name in world:
            return world[name]
        if name in stack:
            raise ValueError(f"Cyclic unit node hierarchy: {stack}")
        mode, parent = geometry["parents"][name]
        matrix = local[name]
        if mode == NODE_PARENT_LOCAL:
            matrix = resolve(names[parent], (*stack, name)) @ matrix
        elif mode != NODE_PARENT_NONE:
            raise ValueError(f"Unsupported external unit node parent type {mode}")
        world[name] = matrix
        return matrix

    for name in names:
        resolve(name)
    return world


def marker_geometry(geometry):
    result = {field: geometry[field] for field in ("nodes", "local_nodes", "parents", "volumes")}
    result["boarding_shapes"] = [
        {"node": actor["node"], "shapes": [{field: shape[field] for field in ("type", "transform", "parameters")}
                                           for shape in actor["shapes"]]}
        for actor in geometry["actors"] if actor["name"] == murmur64("c_box_center") >> 32]
    return result


def read_actors(cursor, group):
    actors = []
    for _ in range(cursor.count()):
        name, template, node, mass = cursor.read("<3If")
        shapes = []
        for _ in range(cursor.count()):
            kind, material, shape_template = cursor.read("<3I")
            matrix = cursor.matrix()
            data, size = cursor.bytes()
            extra_data, extra_size = cursor.bytes()
            geometry = cursor.count()
            if kind == CollisionShape.SPHERE:
                parameters = list(cursor.read("<f"))
            elif kind == CollisionShape.BOX:
                parameters = list(cursor.read("<3f"))
            elif kind == CollisionShape.CAPSULE:
                parameters = list(cursor.read("<2f"))
            elif kind in (CollisionShape.TRIANGLE_MESH, CollisionShape.CONVEX_MESH):
                parameters = []
            elif kind == CollisionShape.HEIGHTFIELD:
                parameters = list(cursor.read("<2I3fB"))
            else:
                raise ValueError(f"{cursor.reader.name}: unsupported collision shape {kind}")
            shapes.append({"type": kind, "material": material, "template": shape_template,
                           "geometry": geometry, "transform": matrix.tolist(),
                           "parameters": parameters, "data_offset": data, "data_size": size,
                           "extra_data_offset": extra_data, "extra_data_size": extra_size})
        events = list(cursor.read("<6I"))
        flags = list(cursor.read("<4B"))
        if any(flag not in (0, 1) for flag in flags):
            raise ValueError(f"{cursor.reader.name}: invalid actor flags")
        actors.append({"name": name, "template": template, "node": node, "mass": mass, "resource_group": group,
                       "flags": flags, "events": events, "shapes": shapes})
    return actors


def read_unit_geometry(path, *, include_collision=False):
    name, reader = resource(path, murmur64("unit"))
    return name, unit_geometry(reader, include_collision=include_collision)


def unit_geometry(reader, *, include_collision=False):
    """Nodes, actors (with decoded collision surfaces if include_collision) and sections of compiled unit data."""
    cursor = Cursor(reader)
    if cursor.count() != UNIT_VERSION:
        raise ValueError(f"{reader.name}: unsupported unit geometry version")
    for _ in range(cursor.count()):
        skip_mesh(cursor)
    for _ in range(cursor.count()):
        cursor.array(64)
        cursor.array(4)
        for _ in range(cursor.count()):
            cursor.array(4)
    cursor.bytes()
    for _ in range(cursor.count()):
        cursor.skip(4)
        cursor.array(4)
    graph = read_nodes(cursor)
    cursor.array(72)
    actors = read_actors(cursor, ActorWorld.PRIMARY)
    actors.extend(read_actors(cursor, ActorWorld.SECONDARY))
    dynamic_data, serialized_assets, flow, volumes = read_sections(cursor)
    if include_collision:
        for actor in actors:
            for shape in actor["shapes"]:
                shape["surface"] = decode_shape(reader, shape)
    return {**graph, "actors": actors, "volumes": volumes, "dynamic_data": dynamic_data,
            "serialized_assets": serialized_assets, "flow": flow}
