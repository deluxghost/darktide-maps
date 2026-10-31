"""Checked readers for compiled Darktide resources."""

import struct
from pathlib import Path


class Binary:
    def __init__(self, data, name):
        self.data = data
        self.name = str(name)

    def check(self, offset, size):
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise ValueError(f"{self.name}: invalid byte range {offset}+{size}")

    def unpack(self, layout, offset):
        self.check(offset, struct.calcsize(layout))
        return struct.unpack_from(layout, self.data, offset)

    def array(self, offset, stride):
        count, relative = self.unpack("<Ii", offset)
        start = offset + 4 + relative
        self.check(start, count * stride)
        return count, start

    def reference(self, offset):
        size, relative = self.unpack("<Ii", offset)
        if size == 0:
            raise ValueError(f"{self.name}: null blob reference at {offset}")
        start = offset + 4 + relative
        self.check(start, size)
        return start, size


def resource_variants(path, expected_type):
    path = Path(path)
    raw = path.read_bytes()
    reader = Binary(raw, path)
    kind, name, variants, reserved = reader.unpack("<QQII", 0)
    if kind != expected_type or variants == 0 or reserved != 0:
        raise ValueError(f"{path}: unsupported compiled resource header")
    headers = [reader.unpack("<IBIBI", 24 + index * 14) for index in range(variants)]
    offset = 24 + variants * 14
    result = []
    for variant, flags, size, valid, tail in headers:
        if flags != 0 or valid != 1:
            raise ValueError(f"{path}: unsupported resource variant flags")
        reader.check(offset, size + tail)
        result.append((variant, Binary(raw[offset:offset + size], path)))
        offset += size + tail
    if len(raw) != offset:
        raise ValueError(f"{path}: resource size mismatch")
    return name, result


def resource(path, expected_type):
    name, variants = resource_variants(path, expected_type)
    if len(variants) != 1 or variants[0][0] != 0:
        raise ValueError(f"{path}: expected a single default resource variant")
    return name, variants[0][1]
