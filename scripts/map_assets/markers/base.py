"""Convert static components into candidate marker families."""

from collections import defaultdict

import numpy as np

from ..formats.level import key32
from ..scene.components import component_value
from ..scene.main_path import route_triggers
from ..formats.unit_geometry import node_matrices
from ..config import configuration

MARKER_FAMILIES = ("chests", "health_stations", "respawn_points", "pickups",
                   "boss_spawns", "daemonhosts", "havoc_boss_spawns")


def build_markers(mission, scene, geometry, definitions, settings, path):
    families = defaultdict(list)
    for unit in scene:
        attached = unit["components"]
        names = {component["name"] for component in attached}
        if not names.intersection(definitions):
            continue
        transforms = node_matrices(geometry[unit["resource"]], unit["node_overrides"])
        matrix = np.array(unit["transform"])
        identity = "/".join([*unit["ancestry"], unit["unit"]])
        source = {"unit_id": identity, "unit_resource": unit["resource"], "level": unit["level"]}

        def node_position(name):
            key = key32(name)
            if key not in transforms:
                raise ValueError(f"{unit['resource']}: missing marker node {name}")
            return (matrix @ transforms[key])[:3, 3].tolist()

        for component in attached:
            kind = component["name"]
            if kind not in definitions:
                continue
            value = lambda field: component_value(component, definitions, field)
            if kind == "Chest":
                families["chests"].append({"position": unit["position"], "source": source})
            elif kind == "HealthStation":
                full = not value("use_distribution_pool") and value("battery_spawning_mode") == "plugged" and value("available_charges") >= 4
                pin = {"position": unit["position"], "source": source}
                if full:
                    pin["name_key"] = configuration("markers")["sourcePolicies"]["health_stations"]["fullNameKey"]
                families["health_stations"].append(pin)
            elif kind == "RespawnBeacon":
                families["respawn_points"].append({"position": unit["position"],
                                                   "source": {**source, "position_kind": "beacon_root"}})
            elif kind == "PickupSpawner" and not names.intersection({"Chest", "HealthStation"}):
                method = value("spawn_method")
                distribution = settings["pool_types"].get(method, settings["event_types"].get(method))
                if method == "side_mission":
                    distribution = "side_mission"
                if distribution is None:
                    raise ValueError(f"Unsupported pickup spawn method: {method}")
                pickups = "all" if method in settings["pool_types"] and value("ignore_item_list") else [item for item in value("items") if item != "none"]
                for node in value("spawn_nodes"):
                    families["pickups"].append({"position": node_position(node), "spawnable_pickups": pickups,
                                               "source": {**source, "component": component["id"],
                                                          "node": node, "distribution_type": distribution}})
            elif kind == "MonsterSpawner":
                spawn_type = value("spawn_type")
                family = {"monsters": "boss_spawns", "witches": "daemonhosts"}[spawn_type]
                pin = {"position": unit["position"], "source": {**source, "section": value("section"), "spawn_type": spawn_type}}
                if spawn_type == "monsters" and path:
                    pin["trigger"] = {"positions": route_triggers(path, node_position("main_path_connection"), settings["monster_distance"])}
                families[family].append(pin)
    for index, location in enumerate(settings["havoc_locations"].get(mission, [])):
        pin = {"position": location["position"],
               "source": {"settings_index": index, "section": location["section"], "position_kind": "prebaked_havoc_candidate"}}
        if path:
            pin["trigger"] = {"positions": route_triggers(path, location["position"], settings["havoc_distance"])}
        families["havoc_boss_spawns"].append(pin)
    return {family: families[family] for family in MARKER_FAMILIES}
