"""Export shared collision assets with explicit provenance and unmodified shapes."""

from collections import Counter

import numpy as np

from ..formats.resource import murmur64
from ..formats.unit_geometry import marker_geometry, read_unit_geometry


def resource_names(dictionary, hashes):
    result = {}
    for line in dictionary.read_text(encoding="utf-8").splitlines():
        name = murmur64(line)
        if name not in hashes:
            continue
        key = f"{name:016x}"
        if key in result and result[key] != line:
            raise ValueError(f"Ambiguous resource name for {key}")
        result[key] = line
    return result


def export_collision(paths, output, physics, names, node_resources):
    directory = output / "collision_geometry"
    directory.mkdir()
    catalog, selected_geometry = {}, {}
    stats = Counter()
    for key, path in paths.items():
        name, geometry = read_unit_geometry(path, include_collision=True)
        if name != key:
            raise ValueError(f"{path}: collision resource identity mismatch")
        identity = f"{name:016x}"
        stats["resources_read"] += 1
        for kind, count in geometry["serialized_assets"].items():
            stats[f"shared_{kind}"] += count
        if identity in node_resources:
            selected_geometry[identity] = marker_geometry(geometry)
        if not geometry["actors"]:
            continue
        if identity not in names:
            stats["unresolved_resource_names"] += 1
        arrays = {}
        for actor_index, actor in enumerate(geometry["actors"]):
            physics["actors"][actor["template"]]
            if actor["node"] not in geometry["nodes"]:
                raise ValueError(f"{path}: actor references an unknown unit node")
            stats["actors"] += 1
            for shape_index, shape in enumerate(actor["shapes"]):
                if shape["extra_data_size"]:
                    raise ValueError(f"{path}: additional cooked collision data is not supported")
                profile = physics["shapes"][shape["template"]]
                stats[f"shape_{shape['type']}"] += 1
                stats["player_filter_matches"] += profile["matches_player_mover_filter"]
                surface = shape.pop("surface")
                storage = {}
                for field, data in surface.items():
                    if isinstance(data, np.ndarray):
                        array_key = f"a{actor_index}_s{shape_index}_{field}"
                        arrays[array_key] = data
                        storage[field] = array_key
                    else:
                        shape[field] = data
                shape["arrays"] = storage
                if "triangles" in surface:
                    stats["triangles"] += len(surface["triangles"])
                if "samples" in surface:
                    stats["heightfield_samples"] += surface["samples"].size
                if surface.get("topology_euler", 2) != 2:
                    stats["non_spherical_hulls"] += 1
                if surface.get("plane_error", 0) > 0.01:
                    stats["hulls_plane_error_over_1cm"] += 1
                if shape["type"] < 3 and 0 in shape["parameters"]:
                    stats["degenerate_primitives"] += 1
                for field in ("data_offset", "data_size", "extra_data_offset", "extra_data_size"):
                    del shape[field]
        if arrays:
            np.savez_compressed(directory / f"{identity}.npz", **arrays)
        catalog[identity] = {
            "name": names.get(identity), "actors": geometry["actors"],
            "nodes": [{"name": node, "world": matrix.tolist(), "local": geometry["local_nodes"][node].tolist(),
                       "parent": geometry["parents"][node]} for node, matrix in geometry["nodes"].items()],
        }
    stats["collision_resources"] = len(catalog)
    return catalog, selected_geometry, dict(stats)
