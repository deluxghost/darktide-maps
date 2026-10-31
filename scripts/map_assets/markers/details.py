"""Enrich static markers with HUD names and station-owned pickup candidates."""

import numpy as np

from ..scene.components import component_value
from ..config import configuration
from ..formats.level import key32
from ..formats.unit_geometry import node_matrices


def attached(unit, name):
    return next(component for component in unit["components"] if component["name"] == name)


def location_keys(unit, definitions):
    component = attached(unit, "Trigger")
    return [component_value(component, definitions, field)
            for field in ("action_location_name_full", "action_location_name_short")
            if component_value(component, definitions, field) != definitions["Trigger"][field]]


def station_pickup(unit, definitions):
    station = attached(unit, "HealthStation")
    mode = component_value(station, definitions, "battery_spawning_mode")
    pooled = component_value(station, definitions, "use_distribution_pool")
    # Pooled stations may leave the battery at a pickup node instead of in the socket.
    if not pooled and mode != "pickup_location":
        return None
    spawner = attached(unit, "PickupSpawner")
    items = set(component_value(spawner, definitions, "items")) - {"none"}
    if len(items) != 1:
        raise ValueError(f"Health station has ambiguous battery items: {sorted(items)}")
    return items.pop(), component_value(spawner, definitions, "spawn_nodes")


def scene_index(scene):
    return {"/".join([*unit["ancestry"], unit["unit"]]): unit for unit in scene}


def detail_text_keys(markers, scene, definitions, pickups):
    units, keys = scene_index(scene), set()
    for pin in markers["locations"]:
        keys.update(location_keys(units[pin["source"]["unit_id"]], definitions))
    for pin in markers["health_stations"]:
        pickup = station_pickup(units[pin["source"]["unit_id"]], definitions)
        if pickup:
            keys.add(pickups[pickup[0]]["description"])
    for pin in markers["pickups"]:
        items = pin["spawnable_pickups"]
        if isinstance(items, list) and len(items) == 1:
            keys.add(pickups[items[0]]["description"])
    return keys


def enrich_marker_details(markers, scene, geometry, definitions, pickups, text):
    units = scene_index(scene)
    for pin in markers["pickups"]:
        items = pin["spawnable_pickups"]
        pin["pickup_groups"] = [] if items == "all" else sorted({pickups[item]["group"] for item in items})
        if isinstance(items, list) and len(items) == 1:
            pin["name"] = text[pickups[items[0]]["description"]]
    for pin in markers["locations"]:
        names = [text[key] for key in location_keys(units[pin["source"]["unit_id"]], definitions)]
        pin["name"] = {language: " - ".join(name[language] for name in names)
                       for language in names[0]}
    for pin in markers["health_stations"]:
        pin.pop("auxiliary_markers", None)
        unit = units[pin["source"]["unit_id"]]
        pickup = station_pickup(unit, definitions)
        if not pickup:
            continue
        item, nodes = pickup
        transforms = node_matrices(geometry[unit["resource"]], unit["node_overrides"])
        world = np.asarray(unit["transform"])
        pin["auxiliary_markers"] = [{"key": node, "name": text[pickups[item]["description"]],
            "position": (world @ transforms[key32(node)])[:3, 3].tolist()} for node in nodes]
    shapes = configuration("markers")["explosiveShapes"]
    # HazardPropSystem shuffles explosion/fire/none contents at runtime, independently of shape.
    for pin in markers["explosives"]:
        pin["name_key"] = shapes[pin["source"]["unit_resource"]]["nameKey"]
