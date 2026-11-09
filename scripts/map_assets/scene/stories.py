"""Units that level stories animate.

A level story is a keyframed timeline compiled into the level resource; level Flow plays it (opening gates, moving
platforms). Each track stores the level unit index in its second word, not through Flow unit bindings, so a unit
with no components, no unit Flow and no Flow binding can still be moved by a story.
"""

import numpy as np
from scipy.spatial.transform import Rotation

from ..formats.binary import resource
from ..formats.resource import murmur64

STORY_TABLE = 160
STORY_VERSION = 9
STORY_DURATION = 44
STORY_REFERENCE = 48
TRACKS = 112
TRACK_SIZE = 68
ROTATION_CHANNELS = (6, 7, 8)


def story_unit_indices(path):
    """Indices (into the level's unit list) of every unit some story of this level animates."""
    _, reader = resource(path, murmur64("level"))
    table, = reader.unpack("<I", STORY_TABLE)
    if not table:
        return set()
    count, = reader.unpack("<I", table)
    entries = [reader.unpack("<2I", table + 4 + index * 8) for index in range(count)]
    animated = set()
    for _, relative in entries:
        start = table + 4 + count * 8 + relative
        _, tracks = reader.unpack("<2I", start)
        for index in range(tracks):
            animated.add(reader.unpack("<17I", start + TRACKS + index * TRACK_SIZE)[1])
    return animated


def story_tracks(path, story, unit_index):
    """Transform tracks of one unit in one story: (duration, reference matrix, {channel: [(time, value, in, out)]}).

    Channels 0-2 are position, 3-5 scale, 6-8 rotation (radians about successive local axes); each key is a cubic
    curve key (time, value, incoming and outgoing tangent)."""
    _, reader = resource(path, murmur64("level"))
    table, = reader.unpack("<I", STORY_TABLE)
    count, = reader.unpack("<I", table)
    entries = [reader.unpack("<2I", table + 4 + index * 8) for index in range(count)]
    starts = [table + 4 + count * 8 + relative for name, relative in entries if name == story]
    if len(starts) != 1:
        raise ValueError(f"{reader.name}: expected one story {story:08x}, found {len(starts)}")
    start, = starts
    version, track_count = reader.unpack("<2I", start)
    if version != STORY_VERSION:
        raise ValueError(f"{reader.name}: unsupported story version {version}")
    duration, = reader.unpack("<f", start + STORY_DURATION)
    reference = np.array(reader.unpack("<16f", start + STORY_REFERENCE)).reshape((4, 4)).T
    result = {}
    for index in range(track_count):
        words = reader.unpack("<17I", start + TRACKS + index * TRACK_SIZE)
        if words[1] != unit_index:
            continue
        if words[0] != 0 or words[2] != 0 or words[3] > 8 or words[11] != 2 or words[13] != 3:
            raise ValueError(f"{reader.name}: unsupported story track {words}")
        channel = words[3]
        if channel in result:
            raise ValueError(f"{reader.name}: duplicate story channel {channel}")
        offset = start + TRACKS + track_count * TRACK_SIZE + words[16] * 4
        keys = [reader.unpack("<4f", offset + frame * 16) for frame in range(words[12])]
        if not keys or not np.isfinite(keys).all() or any(a[0] >= b[0] for a, b in zip(keys, keys[1:])):
            raise ValueError(f"{reader.name}: invalid story curve")
        result[channel] = keys
    return duration, reference, result


def value_at_key(keys, time):
    """Curve value at one of its key times (a constant curve has that value everywhere)."""
    for key in keys:
        if key[0] == time:
            return key[1]
    if all(key[1] == keys[0][1] for key in keys) and all(a[3] == 0 and b[2] == 0 for a, b in zip(keys, keys[1:])):
        return keys[0][1]
    raise ValueError(f"No story key at {time}")


def rotation_at_key(tracks, time, initial):
    if not any(axis in tracks for axis in ROTATION_CHANNELS):
        return initial
    angles = [value_at_key(tracks[axis], time) if axis in tracks else 0 for axis in ROTATION_CHANNELS]
    return Rotation.from_euler("XYZ", angles).as_matrix()
