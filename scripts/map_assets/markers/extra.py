"""Build interaction, mission, collectible and environmental marker candidates."""

from collections import defaultdict

import numpy as np

from ..scene.components import component_value
from ..config import configuration
from ..formats.level import components, key32
from ..formats.resource import murmur64
from ..formats.unit_geometry import node_matrices
from .tasks import classify_task_markers
from .extraction import normalize_extraction

EXTRA_FAMILIES = ("interactions", "objectives", "locations", "heretic_idols", "martyr_skulls",
                  "fixed_boss_spawns", "explosives", "start_points", "luggables", "extraction_points")
MARKER_CONFIG = configuration("markers")


def source_for(unit, **fields):
    return {"unit_id": "/".join([*unit["ancestry"], unit["unit"]]), "unit_resource": unit["resource"],
            "level": unit["level"], **fields}


def pin_for(unit, **fields):
    return {"position": unit["position"], "source": source_for(unit), **fields}


def build_extra_markers(mission, scene, geometry, definitions, settings, flow, defaults):
    families = {family: [] for family in EXTRA_FAMILIES}
    families["pickups"] = []
    allowed = lambda family: mission["game_mode_name"] not in MARKER_CONFIG["sourcePolicies"][family]["excludedGameModes"]
    started = flow.objectives() if allowed("objectives") else {}
    objective_units = defaultdict(dict)
    diagnostics = {"objectives": [], "locations": []}
    fixed_spawns = list(settings["scripted_boss_spawns"])
    for name in mission.get("terror_event_templates", []):
        for spawn in settings["terror_spawns"]["scripts/settings/terror_event/terror_event_templates/" + name]:
            breed = settings["breeds"].get(spawn.get("breed_name"))
            tags = {tag for group in spawn.get("breed_tags", []) for tag in group}
            if breed and breed.get("is_boss") or tags.intersection(MARKER_CONFIG["sourcePolicies"]["fixed_boss_spawns"]["breedTags"]):
                fixed_spawns.append(spawn)
    pickup_anchors = {entry["identifier"]: entry["pickup"] for entry in settings["scripted_pickups"]}
    interaction_map = mission["game_mode_name"] in MARKER_CONFIG["sourcePolicies"]["interactions"]["includedGameModes"]
    boss_handlers = {component_value(component, definitions, "template")
                     for unit in scene for component in unit["components"] if component["name"] == "BossHandler"}

    def interaction(unit, component, spawned=False):
        value = lambda field: component_value(component, definitions, field)
        if not value("start_enabled") and key32("interactable_enable") not in flow.events_for(unit):
            return
        template = settings["interactions"][value("interaction_type")]
        name = value("hud_description") or template.get("description")
        ui_type = value("ui_interaction_type")
        if ui_type == "use_template":
            ui_type = template.get("ui_interaction_type")
        if not name:
            raise ValueError(f"Interaction has no HUD name: {source_for(unit)}")
        if spawned or ui_type == "point_of_interest" or value("sub_description") == "loc_action_interaction_story_echo":
            families["interactions"].append(pin_for(unit, name_loca_key=name))

    for unit in scene:
        anchor = unit.get("scripted")
        if anchor and mission["game_mode_name"] == "shooting_range":
            identifier = anchor["identifier"]
            if identifier in pickup_anchors:
                pickup = pickup_anchors[identifier]
                families["pickups"].append(pin_for(unit, name_loca_key=settings["pickups"][pickup]["description"],
                    spawnable_pickups=[pickup], source=source_for(unit, distribution_type="primary", scripted_pickup=pickup)))
            elif anchor["resource"]:
                identity = f"{murmur64(anchor['resource']):016x}"
                for component in components(defaults.get(identity, {})):
                    if component["name"] != "Interactable":
                        continue
                    converted = {**component, "data": [[list(k), v] for k, v in component["data"].items()]}
                    interaction(unit, converted, True)
        for component in unit["components"]:
            kind = component["name"]
            if kind not in definitions:
                continue
            value = lambda field: component_value(component, definitions, field)
            if kind == "Interactable":
                if value("interaction_type") == "penance_collectible":
                    families["martyr_skulls"].append(pin_for(unit))
                elif interaction_map and not any(c["name"] in ("Chest", "HealthStation", "PickupSpawner") for c in unit["components"]):
                    template = settings["interactions"][value("interaction_type")]
                    if template.get("ui_interaction_type") == "point_of_interest" or value("ui_interaction_type") == "point_of_interest" or value("sub_description") == "loc_action_interaction_story_echo":
                        interaction(unit, component)
            elif kind == "Destructible" and value("collectible_type") == "heretic_idol":
                families["heretic_idols"].append(pin_for(unit, source=source_for(unit, section=value("collectible_section_id"))))
            elif kind == "HazardProp":
                families["explosives"].append(pin_for(unit, source=source_for(unit, shape=value("hazard_shape"))))
            elif kind == "PlayerSpawner" and allowed("start_points") and value("active") and value("player_side") == "heroes" and value("spawn_identifier") != "bots":
                nodes = node_matrices(geometry[unit["resource"]], unit["node_overrides"])
                spawn_node = nodes[key32("spawn_location")] if key32("spawn_location") in nodes else next(iter(nodes.values()))
                position = (np.asarray(unit["transform"]) @ spawn_node)[:3, 3].tolist()
                families["start_points"].append(pin_for(unit, position=position,
                    source=source_for(unit, spawn_identifier=value("spawn_identifier"))))
            elif kind == "Trigger" and value("trigger_action") == "set_location":
                name = value("action_location_name_full")
                if name == definitions["Trigger"]["action_location_name_full"]:
                    raise ValueError(f"Location trigger has a placeholder name: {source_for(unit)}")
                families["locations"].append(pin_for(unit, name_loca_key=name))
                diagnostics["locations"].append({"name": name, "source": source_for(unit), "spatial_kind": "trigger_volume"})
            elif kind == "MissionObjectiveTarget" and value("register_self") and value("objective_name") in started:
                objective_units[value("objective_name")][source_for(unit)["unit_id"]] = unit
            elif kind == "MinionSpawner":
                groups = set(value("spawner_groups"))
                matches = [spawn for spawn in fixed_spawns if spawn.get("spawner_group", spawn.get("spawner_id")) in groups]
                if not matches:
                    continue
                nodes = node_matrices(geometry[unit["resource"]], unit["node_overrides"])
                matrix = np.asarray(unit["transform"]) @ next(iter(nodes.values()))
                position = matrix[:3, 3].copy()
                if key32("spawn_node") in nodes:
                    position = (np.asarray(unit["transform"]) @ nodes[key32("spawn_node")])[:3, 3]
                position += matrix[:3, :3] @ np.asarray(value("spawn_offset"))
                breeds = {spawn["breed_name"] for spawn in matches if "breed_name" in spawn}
                pin = pin_for(unit, position=position.tolist(), source=source_for(unit, spawner_groups=sorted(groups), breeds=sorted(breeds)))
                if len(breeds) == 1 and "display_name" in settings["breeds"][next(iter(breeds))]:
                    pin["name_loca_key"] = settings["breeds"][next(iter(breeds))]["display_name"]
                families["fixed_boss_spawns"].append(pin)
            elif kind == "TwinCaptainSpawner":
                families["fixed_boss_spawns"].append(pin_for(unit, source=source_for(unit, twin_id=value("twin_id"), section=value("section"))))
            elif kind == "BossHandlerPosition":
                for handler in boss_handlers:
                    spawn = settings["boss_handlers"][handler]
                    if value("position_name") == spawn["position"]:
                        families["fixed_boss_spawns"].append(pin_for(unit, name_loca_key=settings["breeds"][spawn["breed_name"]]["display_name"]))

    for name, sources in started.items():
        if name not in settings["objectives"]:
            diagnostics["objectives"].append({"objective": name, "spatial_kind": "undefined_objective"})
            continue
        definition = settings["objectives"][name]
        if definition.get("hidden") or not definition.get("header"):
            continue
        targets = objective_units[name]
        if not targets:
            targets.update((source_for(unit)["unit_id"], unit) for unit in sources
                           if any(c["name"] in {"Trigger", "Interactable"} for c in unit["components"]))
        for unit in targets.values():
            families["objectives"].append(pin_for(unit, name_loca_key=definition["header"],
                source=source_for(unit, objective=name)))
        diagnostics["objectives"].append({"objective": name, "name": definition["header"],
            "points": [unit["position"] for unit in targets.values()],
            "region_anchors": sum(any(c["name"] == "Trigger" or c["name"].startswith("MissionObjectiveZone")
                                      for c in unit["components"]) for unit in targets.values()),
            "spatial_kind": "multiple_anchors" if len(targets) > 1 else "anchor" if targets else "nonspatial"})
    classify_task_markers(families, scene, definitions, settings["pickups"])
    if allowed("objectives"):
        diagnostics["extraction"] = normalize_extraction(families, flow, geometry, definitions)
    return families, diagnostics
