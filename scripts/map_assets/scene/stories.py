"""Units that level stories animate.

A level story is a keyframed timeline compiled into the level resource; level Flow plays it (opening gates, moving
platforms). Each track stores the level unit index in its second word, not through Flow unit bindings, so a unit
with no components, no unit Flow and no Flow binding can still be moved by a story.
"""

from collections import Counter

import numpy as np
from scipy.spatial.transform import Rotation

from ..formats.binary import resource
from ..formats.resource import murmur64
from .objects import walk_levels

STORY_TABLE = 160
STORY_VERSION = 9
STORY_DURATION = 44
STORY_REFERENCE = 48
TRACKS = 112
TRACK_SIZE = 68
POSITION_CHANNELS = (0, 1, 2)
SCALE_CHANNELS = (3, 4, 5)
ROTATION_CHANNELS = (6, 7, 8)
MIN_STORY_SCALE = float(np.float32(1e-6))
POSE_DIGITS = 4                 # story poses closer than this (m, matrix entries) are one pose


def story_units(path):
    """{level unit index: [names of the stories of this level that animate it]}."""
    _, reader = resource(path, murmur64("level"))
    table, = reader.unpack("<I", STORY_TABLE)
    if not table:
        return {}
    count, = reader.unpack("<I", table)
    entries = [reader.unpack("<2I", table + 4 + index * 8) for index in range(count)]
    animated = {}
    for name, relative in entries:
        start = table + 4 + count * 8 + relative
        _, tracks = reader.unpack("<2I", start)
        for index in range(tracks):
            stories = animated.setdefault(reader.unpack("<17I", start + TRACKS + index * TRACK_SIZE)[1], [])
            if name not in stories:
                stories.append(name)
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


def key_pose(tracks, time, local):
    """Level-local unit matrix at one key time of a story (channels it does not animate keep the placed values), or
    None when an animated channel has no key at that time."""
    try:
        return pose_at(tracks, time, local)
    except ValueError:
        return None


def pose_at(tracks, time, local):
    scale = np.linalg.norm(local[:3, :3], axis=0)
    pose = local.copy()
    pose[:3, 3] = [value_at_key(tracks[axis], time) if axis in tracks else local[axis, 3] for axis in POSITION_CHANNELS]
    story_scale = np.array([value_at_key(tracks[axis], time) if axis in tracks else scale[axis - 3]
                            for axis in SCALE_CHANNELS])
    story_scale[story_scale == 0] = MIN_STORY_SCALE
    pose[:3, :3] = rotation_at_key(tracks, time, local[:3, :3] / scale) * story_scale
    return pose


def story_poses(root, levels, level_paths, scene, cache):
    """Set unit["story_poses"]: world matrices of every key pose that a level story moves the unit to (other than its
    placed pose). Players can stand on a story-moved unit wherever a story leaves it. Returns skipped counts."""
    placements = {tuple(ancestry): matrix for _, _, matrix, ancestry in walk_levels(root, levels)}
    indices = {}
    skipped = Counter()
    for unit in scene:
        level = unit["level"]
        if level not in cache:
            cache[level] = story_units(level_paths[level])
        if not cache[level]:
            continue
        if level not in indices:
            indices[level] = {item["id"]: index for index, item in enumerate(levels[level]["units"])}
        index = indices[level].get(unit["unit"])
        if index not in cache[level]:
            continue
        placement = placements[tuple(unit["ancestry"])]
        placed = np.array(unit["transform"])
        local = np.linalg.inv(placement) @ placed
        seen = {tuple(np.round(placed, POSE_DIGITS).ravel())}
        poses = []
        for story in cache[level][index]:
            try:
                _, reference, tracks = story_tracks(level_paths[level], story, index)
            except ValueError:      # tracks that are not unit transform curves
                skipped["unsupported_story_track"] += 1
                continue
            if not np.array_equal(reference, np.eye(4)):
                skipped["nonidentity_story_reference"] += 1
                continue
            for time in sorted({key[0] for keys in tracks.values() for key in keys}):
                pose = key_pose(tracks, time, local)
                if pose is None:
                    skipped["unaligned_story_keys"] += 1
                    continue
                world = placement @ pose
                identity = tuple(np.round(world, POSE_DIGITS).ravel())
                if identity not in seen:
                    seen.add(identity)
                    poses.append(world.tolist())
        if poses:
            unit["story_poses"] = poses
    return dict(skipped)
