"""Resource identities and package dependency tables."""

from .binary import resource


def murmur64(text):
    data = text.encode("utf-8")
    mask, multiplier, shift = (1 << 64) - 1, 0xC6A4A7935BD1E995, 47
    value = len(data) * multiplier & mask
    end = len(data) // 8 * 8
    for offset in range(0, end, 8):
        item = int.from_bytes(data[offset:offset + 8], "little") * multiplier & mask
        item ^= item >> shift
        value = (value ^ (item * multiplier & mask)) * multiplier & mask
    if end != len(data):
        value ^= int.from_bytes(data[end:], "little")
        value = value * multiplier & mask
    value ^= value >> shift
    value = value * multiplier & mask
    return value ^ (value >> shift)


def read_package(path):
    _, reader = resource(path, murmur64("package"))
    version, count = reader.unpack("<II", 0)
    if version != 43 or len(reader.data) != 8 + count * 16 + 1 or reader.data[-1] != 1:
        raise ValueError(f"{path}: unsupported package layout")
    return [reader.unpack("<QQ", 8 + index * 16) for index in range(count)]
