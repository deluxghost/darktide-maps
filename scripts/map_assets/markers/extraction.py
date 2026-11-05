"""Normalize spatial mission-completion markers without matching HUD wording."""

import numpy as np
from shapely.geometry import Point, Polygon

from ..scene.components import component_value
from ..config import configuration
from ..formats.level import key32
from ..formats.unit_geometry import node_matrices
from ..formats.collision_geometry import CollisionShape


def unit_identity(unit):
    return "/".join([*unit["ancestry"], unit["unit"]])


def completion_region(unit, geometry, definitions):
    kinds = {c["name"]: c for c in unit["components"]}
    if not kinds.keys() & {"Trigger", "MoveablePlatform"}:
        return None
    data = geometry[unit["resource"]]
    nodes = node_matrices(data, unit["node_overrides"])
    world = np.asarray(unit["transform"])
    if "Trigger" in kinds:
        volume = {**data["volumes"], **unit["volume_overrides"]}[key32("c_volume")]
        bounds = np.asarray(volume["bounds"])
        polygon = Polygon(volume["polygon"])
        if polygon.is_empty or not polygon.is_valid:
            raise ValueError(f"Invalid extraction trigger polygon: {unit_identity(unit)}")
        point = polygon.representative_point()
        position = [point.x, point.y, bounds[0, 2], 1]
        return world @ nodes[key32("c_volume")], bounds, position, polygon
    if not component_value(kinds["MoveablePlatform"], definitions, "require_all_players_onboard"):
        return None
    boxes = [(actor, shape) for actor in data["boarding_shapes"] for shape in actor["shapes"]]
    if len(boxes) != 1 or boxes[0][1]["type"] != CollisionShape.BOX:
        raise ValueError(f"Extraction platform has no unambiguous boarding box: {unit_identity(unit)}")
    actor, shape = boxes[0]
    extents = np.asarray(shape["parameters"])
    matrix = world @ nodes[actor["node"]] @ np.asarray(shape["transform"])
    return matrix, np.asarray([-extents, extents]), [0, 0, -extents[2], 1], None


def normalize_extraction(families, flow, geometry, definitions):
    tolerance = configuration("markers")["extraction"]
    candidates = families["objectives"]
    families["extraction_points"] = []
    diagnostics, handled = [], set()
    for key, script in flow.scripts:
        function = "FlowCallbacks.complete_game_mode"
        if function not in script["functions"]:
            continue
        for unit in flow.spatial_sources(key, script["functions"].index(function)):
            identity = unit_identity(unit)
            if identity in handled:
                continue
            handled.add(identity)
            region = completion_region(unit, geometry, definitions)
            if region is None:
                diagnostics.append({"unit": identity, "spatial_kind": "nonspatial_completion"})
                continue
            matrix, bounds, center, polygon = region
            position = (matrix @ center)[:3]
            inverse = np.linalg.inv(matrix)
            scale = np.linalg.norm(matrix[:3, :3], axis=0)
            padding = np.asarray([tolerance["horizontalDistance"], tolerance["horizontalDistance"],
                                  tolerance["verticalDistance"]]) / scale

            def overlaps(pin):
                local = (inverse @ [*pin["position"], 1])[:3]
                if not np.all((local >= bounds[0] - padding) & (local <= bounds[1] + padding)):
                    return False
                return polygon is None or polygon.distance(Point(local[:2])) <= max(padding[:2])

            nearby = [pin for pin in candidates if overlaps(pin)]
            if nearby:
                chosen = min(nearby, key=lambda pin: (pin["source"]["unit_id"] != identity,
                                                    np.linalg.norm(np.asarray(pin["position"]) - position)))
            else:
                chosen = {"position": position.tolist(), "source": {
                    "unit_id": identity, "unit_resource": unit["resource"], "level": unit["level"]}}
                families["extraction_points"].append(chosen)
            diagnostics.append({"unit": identity, "position": chosen["position"],
                                "marker_unit": chosen["source"]["unit_id"], "nearby_game_markers": len(nearby),
                                "spatial_kind": "completion_region"})
    return diagnostics
