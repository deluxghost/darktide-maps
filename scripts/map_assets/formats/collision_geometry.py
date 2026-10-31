"""Decode the geometry prefix of PhysX cooked meshes, not their acceleration trees."""

import numpy as np

from .binary import Binary


def array(reader, offset, count, dtype, width=1):
    dtype = np.dtype(dtype)
    reader.check(offset, count * width * dtype.itemsize)
    return np.frombuffer(reader.data, dtype=dtype, count=count * width, offset=offset).reshape((count, width))


def checked_surface(reader, vertices, triangles):
    if not np.isfinite(vertices).all() or not len(vertices) or not len(triangles):
        raise ValueError(f"{reader.name}: empty or non-finite collision surface")
    if np.max(triangles) >= len(vertices):
        raise ValueError(f"{reader.name}: collision triangle index out of range")
    return {"vertices": vertices, "triangles": triangles}


def triangle_mesh(reader):
    header, version, midphase, flags, vertices, triangles = reader.unpack("<8s5I", 0)
    if header != b"NXS\x01MESH" or version != 15 or midphase != 1 or flags & ~63 or flags & 12 == 12:
        raise ValueError(f"{reader.name}: unsupported cooked triangle mesh header")
    points = array(reader, 28, vertices, "<f4", 3)
    index_type = "u1" if flags & 4 else "<u2" if flags & 8 else "<u4"
    indices = array(reader, 28 + vertices * 12, triangles, index_type, 3)
    return checked_surface(reader, points, indices)


def convex_mesh(reader):
    header, version, flags, hull, hull_version, vertices, edges, polygons, references = reader.unpack("<8s2I8s5I", 0)
    if (header, version, flags, hull, hull_version) != (b"NXS\x01CVXM", 13, 0, b"ICE\x01CLHL", 9):
        raise ValueError(f"{reader.name}: unsupported cooked convex mesh header")
    points = array(reader, 44, vertices, "<f4", 3)
    polygon_start = 44 + vertices * 12
    index_start = polygon_start + polygons * 20
    indices = array(reader, index_start, references, "u1").ravel()
    if not len(points) or not np.isfinite(points).all():
        raise ValueError(f"{reader.name}: invalid convex vertices")
    triangles = []
    planes = []
    plane_error = 0.0
    for index in range(polygons):
        *plane, start, count, minimum = reader.unpack("<4fHBB", polygon_start + index * 20)
        if count < 3 or start + count > references or minimum >= vertices:
            raise ValueError(f"{reader.name}: invalid convex polygon")
        face = indices[start:start + count]
        if np.max(face) >= vertices or len(set(face.tolist())) != count or not np.isfinite(plane).all():
            raise ValueError(f"{reader.name}: invalid convex polygon vertices")
        distance = points @ np.array(plane[:3]) + plane[3]
        # Cooked hull polygons can retain millimetre-scale non-planarity.
        plane_error = max(plane_error, float(np.max(np.abs(distance[face]))), float(np.max(distance)))
        planes.append(plane)
        triangles.extend((int(face[0]), int(face[item]), int(face[item + 1])) for item in range(1, count - 1))
    edge_count = edges & 0x7fff
    if references != edge_count * 2:
        raise ValueError(f"{reader.name}: convex edge/reference count mismatch")
    surface = checked_surface(reader, points, np.array(triangles, dtype="<u4"))
    return {**surface, "planes": np.array(planes, dtype="<f4"), "plane_error": plane_error,
            "topology_euler": vertices - edge_count + polygons}


def decode_shape(reader, shape):
    start, size = shape["data_offset"], shape["data_size"]
    reader.check(start, size)
    cooked = Binary(reader.data[start:start + size], f"{reader.name}:shape@{start}")
    if shape["type"] == 3:
        return triangle_mesh(cooked)
    if shape["type"] == 4:
        return convex_mesh(cooked)
    if shape["type"] == 5:
        rows, columns, *_, multiple_materials = shape["parameters"]
        if size != rows * columns * 4 or multiple_materials not in (0, 1):
            raise ValueError(f"{cooked.name}: invalid heightfield sample layout")
        samples = np.frombuffer(cooked.data, dtype=[("height", "<i2"), ("material0", "u1"), ("material1", "u1")])
        return {"samples": samples.reshape(rows, columns)}
    if size:
        raise ValueError(f"{cooked.name}: unexpected cooked data for primitive shape")
    if not np.isfinite(shape["parameters"]).all() or any(value < 0 for value in shape["parameters"]):
        raise ValueError(f"{cooked.name}: invalid primitive parameters")
    return {}
