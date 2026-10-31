"""Keep every static route and the connections valid for that route."""

from itertools import product

import numpy as np


def prepare_main_path(mission, data):
    segments = data["main_path_segments"]
    crossroads = data["crossroads"]
    keys = sorted(crossroads)
    breaks = {marker["main_path_segment_index"] - 1 for marker in data["path_markers"]
              if marker["marker_type"] == "break"}
    routes, connections = [], set()
    for choices in product(*(range(1, len(crossroads[key]["roads"]) + 1) for key in keys)):
        selected = dict(zip(keys, choices, strict=True))
        indices = [index for index, segment in enumerate(segments)
                   if "crossroads_id" not in segment or selected[segment["crossroads_id"]] == segment["road_id"]]
        for left, right in zip(indices, indices[1:]):
            connections.add((left, right, "break" if left in breaks else "continuous"))
        positions = np.array([point for index in indices for point in segments[index]["nodes"]], dtype=float)
        distances = np.r_[0, np.cumsum(np.linalg.norm(np.diff(positions, axis=0), axis=1))]
        routes.append({"choices": selected, "segments": indices,
                       "unified_nodes": [{"position": point.tolist(), "travel_distance": float(distance)}
                                         for point, distance in zip(positions, distances, strict=True)]})
    return {"schema_version": 2, "mission": mission, "source": "all_static_branches", **data,
            "segments": segments, "connections": [{"from": left, "to": right, "kind": kind}
                                                     for left, right, kind in sorted(connections)],
            "routes": routes, "stats": {"segments": len(segments), "routes": len(routes),
                                           "nodes": sum(len(segment["nodes"]) for segment in segments)}}


def route_triggers(data, connection_position, distance):
    triggers = {}
    query = np.array(connection_position)
    for route in data["routes"]:
        nodes = route["unified_nodes"]
        points = np.array([node["position"] for node in nodes])
        travel = np.array([node["travel_distance"] for node in nodes])
        starts, ends = points[:-1], points[1:]
        vectors = ends - starts
        squared = np.sum(vectors * vectors, axis=1)
        amounts = np.divide(np.sum((query - starts) * vectors, axis=1), squared,
                            out=np.zeros(len(squared)), where=squared > 0).clip(0, 1)
        closest = starts + vectors * amounts[:, None]
        index = int(np.argmin(np.sum((closest - query) ** 2, axis=1)))
        spawn_distance = travel[index] + amounts[index] * (travel[index + 1] - travel[index])
        trigger_distance = max(0, float(spawn_distance - distance))
        edge = min(int(np.searchsorted(travel, trigger_distance, side="right")) - 1, len(travel) - 2)
        width = travel[edge + 1] - travel[edge]
        amount = (trigger_distance - travel[edge]) / width if width > 0 else 0
        position = points[edge] + (points[edge + 1] - points[edge]) * amount
        identity = tuple(round(value, 4) for value in position)
        if identity not in triggers:
            triggers[identity] = {"position": position.tolist(), "routes": []}
        triggers[identity]["routes"].append(route["choices"])
    return list(triggers.values())
