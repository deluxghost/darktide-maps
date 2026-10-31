"""Read unit volume records, including level-instance replacements."""

import math


def read_volumes(reader, start, size):
    volumes = {}
    end = start + size
    reader.check(start, size)
    while start < end:
        bounds = reader.unpack("<6f", start + 4)
        name, = reader.unpack("<I", start + 28)
        vertices, stride = reader.unpack("<2I", start + 56)
        if stride < 64 or start + stride > end or 64 + vertices * 8 > stride:
            raise ValueError(f"{reader.name}: invalid unit volume extent")
        if name in volumes or not all(math.isfinite(v) for v in bounds):
            raise ValueError(f"{reader.name}: invalid unit volume bounds or name")
        if any(bounds[axis] > bounds[axis + 3] for axis in range(3)):
            raise ValueError(f"{reader.name}: reversed unit volume bounds")
        polygon = [list(reader.unpack("<2f", start + 64 + index * 8)) for index in range(vertices)]
        if any(not math.isfinite(v) for point in polygon for v in point):
            raise ValueError(f"{reader.name}: non-finite unit volume polygon")
        volumes[name] = {"bounds": [list(bounds[:3]), list(bounds[3:])], "polygon": polygon}
        start += stride
    return volumes
