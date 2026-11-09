"""Player-platform dock and boarding rules for map reachability.

Aligned position-track keys define docks for player-side MoveablePlatforms. Boarding contacts come from
g_volume_block or walkable collision faces. Stories with changing rotation/scale, nonidentity reference transforms
or unaligned position keys are reported as skipped.
"""

from collections import Counter

import numpy as np
from scipy.spatial import ConvexHull

from ..formats.level import key32
from .components import component_value
from .objects import walk_levels
from .stories import rotation_at_key, story_tracks, value_at_key

PLATFORM_COMPONENT = "MoveablePlatform"
PLAYER_SIDE = "heroes"
GATE_VOLUME = "g_volume_block"
POSITION_CHANNELS = (0, 1, 2)
SCALE_CHANNELS = (3, 4, 5)
MIN_STORY_SCALE = float(np.float32(1e-6))
KEY_TOLERANCE = 1e-6


def walkable_points(unit, assets, floor_cosine):
    """Unit-local points on the walkable faces (vertices and centres) of a platform's own collision."""
    shapes = assets.place([unit], (np.full(3, -np.inf), np.full(3, np.inf)), Counter(), keep_rejected=True)
    inverse = np.linalg.inv(np.array(unit["transform"]))
    points = []
    for shape in shapes:
        if "vertices" not in shape:
            raise ValueError(f"{unit['unit']}: curved platform surface")
        if shape["convex"]:
            hull = ConvexHull(shape["vertices"])
            triangles = shape["vertices"][hull.simplices[hull.equations[:, 2] >= floor_cosine]]
        else:
            triangles = shape["triangles"]
            normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
            triangles = triangles[normals[:, 2] >= np.linalg.norm(normals, axis=1) * floor_cosine]
        for triangle in triangles:
            for point in (*triangle, triangle.mean(axis=0)):
                points.append((inverse @ np.r_[point, 1])[:3])
    return np.unique(np.round(points, 6), axis=0).tolist() if points else []


def varies(keys):
    return any(abs(key[1] - keys[0][1]) > KEY_TOLERANCE for key in keys)


def player_platforms(root, levels, level_paths, scene, definitions, geometry, assets, floor_cosine):
    """Dock poses of every player platform: [{"unit", "ancestry", "story", "docks": [{"time", "transform"}],
    "gate": gate volume or None, "boarding": unit-local walkable points (without a gate)}], and skipped counts."""
    poses = {tuple(ancestry): matrix for _, _, matrix, ancestry in walk_levels(root, levels)}
    result, skipped = [], Counter()
    for unit in scene:
        component = next((c for c in unit["components"] if c["name"] == PLATFORM_COMPONENT), None)
        if component is None or component_value(component, definitions, "player_side") != PLAYER_SIDE:
            continue
        story = component_value(component, definitions, "story")
        unit_index = next(index for index, item in enumerate(levels[unit["level"]]["units"]) if item["id"] == unit["unit"])
        _, reference, tracks = story_tracks(level_paths[unit["level"]], key32(story), unit_index)
        if not np.array_equal(reference, np.eye(4)):
            skipped["nonidentity_story_reference"] += 1
            continue
        if any(varies(keys) for channel, keys in tracks.items() if channel not in POSITION_CHANNELS):
            skipped["rotating_or_scaling_platform"] += 1
            continue
        if not all(axis in tracks for axis in POSITION_CHANNELS):
            raise ValueError(f"{unit['unit']}: incomplete platform position tracks")
        moving = [axis for axis in POSITION_CHANNELS if varies(tracks[axis])]
        times = {tuple(key[0] for key in tracks[axis]) for axis in moving}
        if len(times) > 1:
            skipped["unaligned_position_keys"] += 1
            continue
        placement = poses[tuple(unit["ancestry"])]
        local = np.linalg.inv(placement) @ np.array(unit["transform"])
        scale = np.linalg.norm(local[:3, :3], axis=0)
        rotation = local[:3, :3] / scale
        volumes = {**geometry[unit["resource"]]["volumes"], **unit["volume_overrides"]}
        gate = volumes.get(key32(GATE_VOLUME))
        boarding = None if gate else walkable_points(unit, assets, floor_cosine)
        if gate is None and not boarding:
            raise ValueError(f"{unit['unit']}: player platform has no walkable surface")
        docks = []
        for frame, time in enumerate(times.pop() if times else (0.0,)):
            pose = local.copy()
            pose[:3, 3] = [tracks[axis][frame if axis in moving else 0][1] for axis in POSITION_CHANNELS]
            story_scale = np.array([value_at_key(tracks[axis], time) if axis in tracks else scale[axis - 3]
                                    for axis in SCALE_CHANNELS])
            story_scale[story_scale == 0] = MIN_STORY_SCALE
            pose[:3, :3] = rotation_at_key(tracks, time, rotation) * story_scale
            docks.append({"time": time, "transform": (placement @ pose).tolist()})
        result.append({"unit": unit["unit"], "ancestry": unit["ancestry"], "story": story, "docks": docks,
                       "gate": gate, "boarding": boarding})
    return result, dict(skipped)
