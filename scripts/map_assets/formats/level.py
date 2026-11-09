"""Read Darktide v125 level placements and per-instance dynamic configuration."""

import math

from .binary import Binary, resource
from .dynamic_data import DynamicDataType
from .resource import murmur64
from .flow import LevelFlow
from .unit_volumes import read_volumes

LEVEL_VERSION = 125


def key32(name):
    return murmur64(name) >> 32


def read_config(reader, offset):
    count, = reader.unpack("<I", offset)
    offset += 4
    result = {}
    for _ in range(count):
        depth, = reader.unpack("<I", offset)
        offset += 4
        keys = reader.unpack(f"<{depth}I", offset)
        offset += depth * 4
        kind, = reader.unpack("<I", offset)
        offset += 4
        if kind == DynamicDataType.BOOLEAN:
            value, = reader.unpack("<I", offset)
            if value not in (0, 1):
                raise ValueError(f"{reader.name}: invalid dynamic boolean")
            value = bool(value)
            offset += 4
        elif kind == DynamicDataType.NUMBER:
            value, = reader.unpack("<f", offset)
            if not math.isfinite(value):
                raise ValueError(f"{reader.name}: non-finite dynamic number")
            offset += 4
        elif kind == DynamicDataType.STRING:
            size, = reader.unpack("<I", offset)
            offset += 4
            reader.check(offset, size)
            raw = reader.data[offset:offset + size]
            if not raw.endswith(b"\0"):
                raise ValueError(f"{reader.name}: unterminated dynamic string")
            value = raw[:-1].decode("utf-8")
            offset += (size + 3) & ~3
        else:
            raise ValueError(f"{reader.name}: unsupported dynamic config type {kind}")
        if keys in result:
            raise ValueError(f"{reader.name}: duplicate dynamic config path {keys}")
        result[keys] = value
    return result, offset


def transform(reader, offset):
    values = reader.unpack("<10f", offset)
    if not all(math.isfinite(value) for value in values):
        raise ValueError(f"{reader.name}: non-finite placement transform")
    return {"position": list(values[:3]), "rotation": list(values[3:7]), "scale": list(values[7:])}


def read_object_sets(reader, unit_count):
    """Per unit, the name hashes (key32) of the level object sets it belongs to; themes hide whole sets."""
    set_count, names, table = reader.unpack("<3I", 116)
    known = set()
    for index in range(set_count):
        start, = reader.unpack("<I", names + index * 4)
        end = reader.data.index(0, start)
        known.add(key32(reader.data[start:end].decode("utf-8")))
    result = []
    for index in range(unit_count):
        count, offset = reader.unpack("<2I", table + index * 8)
        sets = list(reader.unpack(f"<{count}I", offset)) if count else []
        if not set(sets) <= known:
            raise ValueError(f"{reader.name}: unit {index} references an unknown object set")
        result.append(sets)
    return result


EMBEDDED_UNITS = 108   # count and table offset of the unit data compiled into the level (entries: offset, size, id)


def embedded_units(path):
    """Units compiled into a level resource itself (its own collision, such as its player_mover_blocker volumes):
    [(unit id, Binary of the unit data)]."""
    _, reader = resource(path, murmur64("level"))
    count, start = reader.unpack("<2I", EMBEDDED_UNITS)
    units = []
    for index in range(count):
        offset, size, unit = reader.unpack("<2IQ", start + index * 16)
        reader.check(offset, size)
        units.append((unit, Binary(reader.data[offset:offset + size], f"{reader.name}:unit{index}")))
    return units


def read_level(path):
    name, reader = resource(path, murmur64("level"))
    zero, version, unit_count = reader.unpack("<3I", 0)
    if (zero, version) != (0, LEVEL_VERSION):
        raise ValueError(f"{path}: unsupported level version {version}")
    script_table, = reader.unpack("<I", 16)
    memberships = read_object_sets(reader, unit_count)
    units = []
    for index in range(unit_count):
        offset = 192 + index * 96
        identity, editor_name, unit = reader.unpack("<3Q", offset)
        script, = reader.unpack("<I", script_table + index * 4)
        config = read_config(reader, script)[0] if script else {}
        node_count, node_offset = reader.unpack("<2I", offset + 72)
        volume_size, volume_offset = reader.unpack("<2I", offset + 80)
        volumes = read_volumes(reader, volume_offset, volume_size)
        overrides = []
        for node_index in range(node_count):
            start = node_offset + node_index * 48
            position = reader.unpack("<3f", start)
            node, = reader.unpack("<I", start + 12)
            rotation_scale = reader.unpack("<7f", start + 16)
            flags, = reader.unpack("<I", start + 44)
            if flags != 0:
                raise ValueError(f"{path}: unsupported node override flags {flags}")
            overrides.append({"node": node, "position": list(position),
                              "rotation": list(rotation_scale[:4]), "scale": list(rotation_scale[4:])})
        units.append({"id": f"{identity:016x}", "editor_name": f"{editor_name:016x}",
                      "resource": f"{unit:016x}", **transform(reader, offset + 32),
                      "node_overrides": overrides, "volume_overrides": volumes, "config": config,
                      "object_sets": memberships[index]})
    nested_count, nested_offset = reader.unpack("<2I", 136)
    nested = []
    for _ in range(nested_count):
        identity, level = reader.unpack("<2Q", nested_offset)
        size, = reader.unpack("<I", nested_offset + 56)
        if size < 72 or size % 8:
            raise ValueError(f"{path}: invalid nested level record size {size}")
        reader.check(nested_offset, size)
        start = nested_offset + 64
        end = reader.data.index(0, start, nested_offset + size)
        level_path = reader.data[start:end].decode("utf-8")
        if murmur64(level_path) != level:
            raise ValueError(f"{path}: nested level name hash mismatch")
        nested.append({"id": f"{identity:016x}", "resource": f"{level:016x}",
                       "name": level_path, **transform(reader, nested_offset + 16)})
        nested_offset += size
    nav_count, nav_offset = reader.unpack("<2I", 148)
    navigation = []
    for index in range(nav_count):
        nav, flags = reader.unpack("<2Q", nav_offset + index * 16)
        navigation.append({"resource": f"{nav:016x}", "flags": flags})
    return {"resource": f"{name:016x}", "units": units, "nested": nested, "navigation": navigation,
            "flow": LevelFlow(reader, unit_count, nested_count)}


def components(config):
    names = {path[1]: value for path, value in config.items()
             if len(path) == 3 and path[0] == key32("components") and path[2] == key32("name")}
    result = []
    for identity, name in names.items():
        data = {path[3:]: value for path, value in config.items()
                if len(path) >= 4 and path[:3] == (key32("components"), identity, key32("component_data"))}
        result.append({"id": f"{identity:08x}", "name": name, "data": data})
    return result
