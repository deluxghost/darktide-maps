"""Locate unit dynamic configuration and shared PhysX assets by serialized fields."""

from collections import Counter

from .binary import Binary
from .unit_volumes import read_volumes

PHYSX_VERSION = 0x04010200
PHYSX_BINARY_GUID = b"77E92B17A4084033A0FDB51332D5A6BB"
SHARED_ASSET_TYPES = {2: "convex_mesh", 8: "material"}
JOINT_DATA_BYTES = {0: 60, 1: 28, 5: 20, 8: 293}


def require_empty(cursor, label):
    if cursor.count():
        raise ValueError(f"{cursor.reader.name}: unsupported nonempty unit {label}")


def read_collection(reader, offset, size):
    if not size:
        return {}
    data = Binary(reader.data[offset:offset + size], reader.name)
    version, = data.unpack("<I", 4)
    if data.data[:4] != b"SEBD" or version != PHYSX_VERSION or data.data[8:40] != PHYSX_BINARY_GUID:
        raise ValueError(f"{reader.name}: unsupported serialized PhysX collection")
    if data.data[40:44] != b"W_64":
        raise ValueError(f"{reader.name}: unsupported serialized PhysX platform")
    count, = data.unpack("<I", 48)
    manifest_count, = data.unpack("<I", 64)
    if count != manifest_count:
        raise ValueError(f"{reader.name}: PhysX collection manifest count mismatch")
    end, = data.unpack("<I", 68 + count * 8)
    if end > len(data.data):
        raise ValueError(f"{reader.name}: PhysX object data exceeds collection size")
    types = Counter()
    previous = -1
    for index in range(count):
        start, kind = data.unpack("<IH", 68 + index * 8)
        if start <= previous or start >= end or kind not in SHARED_ASSET_TYPES:
            raise ValueError(f"{reader.name}: unsupported PhysX object {kind} at {start}")
        previous = start
        types[SHARED_ASSET_TYPES[kind]] += 1
    # These collections contain resources, not actors or their scene placements.
    return dict(types)


def read_sections(cursor):
    cursor.array(4)  # actor lookup
    cursor.array(32)  # cameras
    cursor.array(160)  # lights
    start, size = cursor.bytes()
    volumes = read_volumes(cursor.reader, start, size)
    for _ in range(cursor.count()):
        cursor.skip(16)
        for _ in range(cursor.count()):
            cursor.skip(8)
            cursor.array(4)
            cursor.skip(8)
        cursor.skip(48)
        cursor.array(4)
        cursor.skip(5)
    for _ in range(cursor.count()):
        cursor.skip(52)
        cursor.array(24)
        cursor.skip(4)
        for _ in range(cursor.count()):
            cursor.skip(304)
            cursor.array(24)
        cursor.bytes()
    require_empty(cursor, "cloth descriptors")
    for _ in range(cursor.count()):
        cursor.skip(121)
        kind = cursor.count()
        if kind not in JOINT_DATA_BYTES:
            raise ValueError(f"{cursor.reader.name}: unsupported joint type {kind}")
        cursor.skip(JOINT_DATA_BYTES[kind])
    cursor.array(28)  # movers
    require_empty(cursor, "secondary physics descriptors")
    cursor.skip(1)
    cursor.bytes()  # animation state machine
    offset, size = cursor.bytes()
    dynamic = cursor.reader.data[offset:offset + size]
    for _ in range(cursor.count()):
        cursor.skip(4)
        cursor.array(4)
    start, size = cursor.bytes()
    flow = cursor.reader.data[start:start + size]
    start, size = cursor.bytes()
    flow_dynamic = cursor.reader.data[start:start + size]
    cursor.bytes()  # render triangle finder
    offset, size = cursor.bytes()
    return dynamic, read_collection(cursor.reader, offset, size), (flow, flow_dynamic), volumes
