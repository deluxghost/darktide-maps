"""Decode the self-relative dynamic-data tree embedded in compiled units."""

import math

from .binary import Binary
from .dynamic_data import DynamicDataType
from .unit_geometry import read_unit_geometry

NO_DATA_OFFSET = 0xFFFFFFFF


def read_tree(reader, offset=0, prefix=()):
    result = {}
    while True:
        key, following, kind, size = reader.unpack("<4I", offset)
        path = (*prefix, key)
        offset += 16
        if kind == DynamicDataType.OBJECT:
            child, = reader.unpack("<I", offset)
            offset += 4
            if size != 4 or child not in (NO_DATA_OFFSET, offset):
                raise ValueError(f"{reader.name}: invalid dynamic child pointer")
            if child != NO_DATA_OFFSET:
                children, offset = read_tree(reader, child, path)
                result.update(children)
        elif kind in (DynamicDataType.BOOLEAN, DynamicDataType.NUMBER):
            if size != 4:
                raise ValueError(f"{reader.name}: invalid dynamic scalar size")
            value, = reader.unpack("<I" if kind == DynamicDataType.BOOLEAN else "<f", offset)
            offset += 4
            if kind == DynamicDataType.BOOLEAN:
                if value not in (0, 1):
                    raise ValueError(f"{reader.name}: invalid dynamic boolean")
                value = bool(value)
            elif not math.isfinite(value):
                raise ValueError(f"{reader.name}: non-finite dynamic scalar")
            result[path] = value
        elif kind == DynamicDataType.STRING:
            reader.check(offset, size)
            raw = reader.data[offset:offset + size]
            end = raw.index(0)
            if any(raw[end:]):
                raise ValueError(f"{reader.name}: nonzero dynamic string padding")
            result[path] = raw[:end].decode("utf-8")
            offset += size
        else:
            raise ValueError(f"{reader.name}: unsupported dynamic tree type {kind}")
        if following == NO_DATA_OFFSET:
            return result, offset
        if following != offset:
            raise ValueError(f"{reader.name}: invalid dynamic sibling pointer")


def read_unit_data(path):
    name, geometry = read_unit_geometry(path)
    raw = geometry["dynamic_data"]
    if not raw:
        return name, {}, geometry["flow"]
    tree = Binary(raw, path)
    root, reserved = tree.unpack("<2I", 0)
    if (root, reserved, len(raw)) == (NO_DATA_OFFSET, 0, 8):
        return name, {}, geometry["flow"]
    if (root, reserved) != (8, 0):
        raise ValueError(f"{path}: unsupported dynamic-data header")
    data, end = read_tree(tree, root)
    if end != len(raw):
        raise ValueError(f"{path}: unit dynamic-data extent mismatch")
    return name, data, geometry["flow"]
