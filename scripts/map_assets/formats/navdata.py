"""Decode static Autodesk Navigation mesh blobs from Darktide NavData."""

import math
import struct
from collections import defaultdict

import numpy as np
import shapely

from .binary import resource

NAVDATA_TYPE = 0x23EE957DD4B1BB94
NAV_MESH_ELEMENT = 1
NON_MESH_BLOBS = {2, 14, 0x500}
PIXEL_SCALE = 128


class RuntimeStitchRequired(ValueError):
    """A loaded sector combination has no complete pre-baked cell version."""


def float32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def blob_records(reader):
    if reader.data[:12] != b"BlobAggFile\0":
        raise ValueError(f"{reader.name}: invalid NavData magic")
    endian, count = reader.unpack("<II", 12)
    if endian != 0:
        raise ValueError(f"{reader.name}: unsupported NavData byte order {endian}")
    offset = 20
    for _ in range(count):
        kind, version, deep_size, shallow_size = reader.unpack("<4I", offset)
        offset += 16
        reader.check(offset, deep_size)
        if shallow_size > deep_size:
            raise ValueError(f"{reader.name}: blob shallow size exceeds deep size")
        yield kind, version, offset, shallow_size, deep_size
        offset += deep_size
    if offset != len(reader.data):
        raise ValueError(f"{reader.name}: bytes remain after NavData blobs")


def read_floor(reader, offset, cell, precision, cell_pixels):
    triangle_count, _ = reader.array(offset, 1)
    edge_count, edges = reader.array(offset + 16, 4)
    vertex_count, vertices = reader.array(offset + 24, 2)
    altitude_count, altitudes = reader.array(offset + 32, 4)
    if edge_count != triangle_count * 3 or altitude_count != vertex_count:
        raise ValueError(f"{reader.name}: inconsistent NavFloor array counts")
    low, high = reader.unpack("<2f", offset + 40)
    points = []
    for index in range(vertex_count):
        x, y = reader.unpack("<2B", vertices + index * 2)
        z, = reader.unpack("<f", altitudes + index * 4)
        if x > cell_pixels or y > cell_pixels or not math.isfinite(z) or not low - 1e-4 <= z <= high + 1e-4:
            raise ValueError(f"{reader.name}: invalid NavFloor vertex")
        points.append([
            float32((cell[0] * cell_pixels + x) * PIXEL_SCALE * precision),
            float32((cell[1] * cell_pixels + y) * PIXEL_SCALE * precision),
            z,
        ])
    triangles = []
    for index in range(triangle_count):
        packed = reader.unpack("<3I", edges + index * 12)
        triangle = [(edge & 0x03FFC000) >> 14 for edge in packed]
        if len(set(triangle)) != 3 or any(vertex >= vertex_count for vertex in triangle):
            raise ValueError(f"{reader.name}: invalid NavFloor triangle indices")
        a, b, c = (points[vertex] for vertex in triangle)
        area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if area == 0:
            raise ValueError(f"{reader.name}: degenerate NavFloor triangle")
        triangles.append(triangle)
    return points, triangles


def read_mesh(reader, offset):
    min_x, min_y, max_x, max_y, count_x, count_y = reader.unpack("<6i", offset)
    if count_x != max_x - min_x + 1 or count_y != max_y - min_y + 1:
        raise ValueError(f"{reader.name}: invalid NavMesh cell bounds")
    radius, height, step, slope, tolerance, precision, cell_pixels = reader.unpack("<6fi", offset + 36)
    if not all(math.isfinite(value) for value in (radius, height, step, slope, tolerance, precision)) or precision <= 0 or not 0 < cell_pixels <= 255:
        raise ValueError(f"{reader.name}: invalid NavMesh generation parameters")
    cell_count, references = reader.array(offset + 68, 8)
    guid_count, guid_data = reader.array(offset + 24, 16)
    guids = frozenset(reader.data[guid_data + index * 16:guid_data + (index + 1) * 16]
                      for index in range(guid_count))
    if not guids or len(guids) != guid_count:
        raise ValueError(f"{reader.name}: invalid NavMesh sector GUIDs")
    timestamp, = reader.unpack("<I", offset + 32)
    cells = []
    for cell_index in range(cell_count):
        cell_offset, _ = reader.reference(references + cell_index * 8)
        cell = reader.unpack("<2i", cell_offset)
        if not min_x <= cell[0] <= max_x or not min_y <= cell[1] <= max_y:
            raise ValueError(f"{reader.name}: cell outside NavMesh bounds")
        cells.append((cell, cell_offset))
    return {"reader": reader, "guids": guids, "timestamp": timestamp, "cells": cells,
            "parameters": (radius, height, step, slope, tolerance, precision, cell_pixels),
            "precision": precision, "cell_pixels": cell_pixels}


def select_cells(meshes):
    if len({mesh["parameters"] for mesh in meshes}) != 1:
        raise ValueError("NavData contains incompatible generation parameters")
    active_guids = set().union(*(mesh["guids"] for mesh in meshes if len(mesh["guids"]) == 1))
    if not active_guids:
        raise ValueError("NavData contains no main sectors")
    candidates = defaultdict(list)
    for mesh in meshes:
        if not mesh["guids"] <= active_guids:
            continue
        for cell, offset in mesh["cells"]:
            candidates[cell].append((mesh, offset))
    for cell, versions in sorted(candidates.items()):
        groups = defaultdict(list)
        for mesh, offset in versions:
            groups[mesh["guids"]].append((mesh, offset))
        maximal = [guids for guids in groups if not any(guids < other for other in groups)]
        selected = []
        for guids in maximal:
            newest = max(mesh["timestamp"] for mesh, _ in groups[guids])
            complete = [(mesh, offset) for mesh, offset in groups[guids] if mesh["timestamp"] == newest]
            if len(complete) != 1:
                raise ValueError(f"Nav cell {cell} has ambiguous baked sector versions")
            selected.append(complete[0])
        for index, a in enumerate(selected):
            for b in selected[index + 1:]:
                if a[0]["guids"] & b[0]["guids"] or not independent_cells(cell, a, b):
                    raise RuntimeStitchRequired(f"Nav cell {cell} has conflicting sectors without a baked combination")
        for mesh, offset in selected:
            yield cell, mesh, offset


def cell_triangles(cell, entry):
    mesh, offset = entry
    reader = mesh["reader"]
    count, references = reader.array(offset + 16, 8)
    for index in range(count):
        floor, _ = reader.reference(references + index * 8)
        points, faces = read_floor(reader, floor, cell, mesh["precision"], mesh["cell_pixels"])
        for face in faces:
            vertices = np.array([points[vertex] for vertex in face])
            plane = np.linalg.solve(np.c_[vertices[:, :2], np.ones(3)], vertices[:, 2])
            yield shapely.Polygon(vertices[:, :2]), plane


def independent_cells(cell, a, b):
    """Separate baked sectors may share a grid cell without sharing walkable space."""
    left, right = list(cell_triangles(cell, a)), list(cell_triangles(cell, b))
    clearance = a[0]["parameters"][1]
    for polygon_a, plane_a in left:
        for polygon_b, plane_b in right:
            overlap = polygon_a.intersection(polygon_b)
            if overlap.area == 0:
                continue
            coordinates = shapely.get_coordinates(overlap)
            differences = np.c_[coordinates, np.ones(len(coordinates))] @ (plane_a - plane_b)
            if not (differences.min() >= clearance or differences.max() <= -clearance):
                return False
    return True


def decode_navmesh(mission, files):
    vertices, triangles, floors, sources = [], [], [], []
    lookup = {}
    meshes = []
    for path in sorted(files):
        name_hash, reader = resource(path, NAVDATA_TYPE)
        mesh_count = 0
        for kind, version, offset, _, _ in blob_records(reader):
            if kind in NON_MESH_BLOBS:
                continue
            if kind != NAV_MESH_ELEMENT or version != 1:
                raise ValueError(f"{path}: unsupported NavData blob {kind}/{version}")
            meshes.append({**read_mesh(reader, offset), "resource": f"{name_hash:016x}", "mesh": mesh_count})
            mesh_count += 1
        sources.append({"resource": f"{name_hash:016x}", "meshes": mesh_count})
    selected = list(select_cells(meshes))
    for cell, mesh, offset in selected:
        reader = mesh["reader"]
        floor_count, references = reader.array(offset + 16, 8)
        for floor_index in range(floor_count):
            floor_offset, _ = reader.reference(references + floor_index * 8)
            points, faces = read_floor(reader, floor_offset, cell, mesh["precision"], mesh["cell_pixels"])
            tile = len(floors) + 1
            floors.append({"resource": mesh["resource"], "mesh": mesh["mesh"],
                           "cell": list(cell), "floor": floor_index})
            indices = []
            for point in points:
                key = tuple(point)
                if key not in lookup:
                    lookup[key] = len(vertices) + 1
                    vertices.append(point)
                indices.append(lookup[key])
            for index, face in enumerate(faces, 1):
                triangles.append([*(indices[vertex] for vertex in face), tile, index])
    if not triangles:
        raise ValueError(f"{mission}: no static navigation triangles")
    return {
        "schema_version": 1,
        "mission": mission,
        "coordinate_system": {"axes": ["x", "y", "z"], "units": "game_world_units"},
        "vertex_fields": ["x", "y", "z"],
        "triangle_fields": ["a", "b", "c", "tile", "triangle"],
        "bounds": {"min": [min(p[axis] for p in vertices) for axis in range(3)],
                   "max": [max(p[axis] for p in vertices) for axis in range(3)]},
        "stats": {"tiles": len(floors), "vertices": len(vertices), "triangles": len(triangles)},
        "vertices": vertices,
        "triangles": triangles,
        "source": {"kind": "offline_navdata", "resources": sources, "floors": floors,
                   "cells": len({cell for cell, _, _ in selected}),
                   "cell_versions": len(selected), "candidate_cells": sum(len(mesh["cells"]) for mesh in meshes)},
    }
