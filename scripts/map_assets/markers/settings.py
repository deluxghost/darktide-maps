"""Read marker semantics from the installed game's component and Lua settings."""

from ..config import configuration
from ..source.lua_data import read_tables

COMPONENT_SOURCES = {
    "Chest": "chest", "HealthStation": "health_station", "MonsterSpawner": "monster_spawner",
    "PickupSpawner": "pickup_spawner", "RespawnBeacon": "respawn_beacon", "Interactable": "interactable",
    "Destructible": "destructible", "HazardProp": "hazard_prop", "Trigger": "trigger",
    "MissionObjectiveTarget": "mission_objective_target", "PlayerSpawner": "player_spawner",
    "MinionSpawner": "minion_spawner", "TwinCaptainSpawner": "twin_captain_spawner",
    "BossHandlerPosition": "boss_handler_position", "BossHandler": "boss_handler",
    "LuggableSynchronizer": "luggable_synchronizer",
    "MoveablePlatform": "moveable_platform",
}


def load_marker_settings(assets, decompiler, missions):
    roots = {
        "interactions": "scripts/settings/interaction/interaction_templates",
        "pickup_registry": "scripts/settings/pickup/pickups",
        "objective_registry": "scripts/settings/mission_objective/mission_objective_templates",
        "scripted_pickups": "scripts/extension_systems/training_grounds/shooting_range_steps",
        "boss_registry": "scripts/managers/pacing/bosses/boss_templates",
        "breed_registry": "scripts/settings/breed/breeds",
    }
    sources = assets.lua_sources(roots.values(), decompiler)
    result = {name: read_tables(name, [sources[path]])[0] for name, path in roots.items()}
    boss_sources = configuration("markers")["scriptedBossSources"]
    boss_scripts = assets.lua_sources(boss_sources, decompiler)
    result["scripted_boss_spawns"] = [spawn for group in read_tables("scripted_boss_spawns", [boss_scripts[path] for path in boss_sources]) for spawn in group]
    hordes_path = "scripts/settings/hordes_mode_settings"
    hordes_source = assets.lua_sources([hordes_path], decompiler)[hordes_path]
    field = lambda name: read_tables("select:hordes_mode_settings." + name, [hordes_source])[0]
    formatter, = read_tables("formatter:hordes_mode_settings.mission_objectives.name_formating_function", [hordes_source])
    objective_context = {"HordesModeSettings": {"waves_per_island": field("waves_per_island"), "mission_objectives": {
        "wave_objective": {"name": field("mission_objectives.wave_objective.name")},
        "between_waves_objective": {"name": field("mission_objectives.between_waves_objective.name")},
        "name_formating_function": formatter}}}
    pickup_paths = result.pop("pickup_registry")
    objective_paths = result.pop("objective_registry")
    boss_paths = result.pop("boss_registry")
    breed_paths = result.pop("breed_registry")
    terror_paths = {"scripts/settings/terror_event/terror_event_templates/" + name
                    for mission in missions.values() for name in mission.get("terror_event_templates", [])}
    sources = assets.lua_sources([*pickup_paths, *objective_paths, *terror_paths, *boss_paths], decompiler)
    pickups = read_tables("fields:name,description,unit_name,unit_names,group", [sources[path] for path in pickup_paths])
    result["pickups"] = {entry["name"]: entry for entry in pickups}
    result["objectives"] = {}
    for group in read_tables("objectives", [sources[path] for path in objective_paths], objective_context):
        for objectives in group.values():
            repeated = result["objectives"].keys() & objectives.keys()
            if repeated:
                raise ValueError(f"Duplicate objective definitions: {sorted(repeated)}")
            result["objectives"].update(objectives)
    result["terror_spawns"] = dict(zip(sorted(terror_paths),
        read_tables("terror_spawns", [sources[path] for path in sorted(terror_paths)]), strict=True))
    result["boss_handlers"] = {}
    for path in boss_paths:
        definition, = read_tables("fields:name", [sources[path]])
        breed, = read_tables("select:SETTINGS.breed_name", [sources[path]])
        position, = read_tables("select:SETTINGS.spawn_position", [sources[path]])
        result["boss_handlers"][definition["name"]] = {"breed_name": breed, "position": position}
    breed_names = {spawn["breed_name"] for spawns in result["terror_spawns"].values()
                   for spawn in spawns if "breed_name" in spawn}
    breed_names.update(spawn["breed_name"] for spawn in result["scripted_boss_spawns"])
    breed_names.update(value["breed_name"] for value in result["boss_handlers"].values())
    sources = assets.lua_sources(breed_paths, decompiler)
    registered = read_tables("fields:name", [sources[path] for path in breed_paths])
    selected = [path for path, breed in zip(breed_paths, registered, strict=True) if breed["name"] in breed_names]
    breeds = read_tables("breed_markers", [sources[path] for path in selected])
    boss_names = "scripts/settings/boss/boss_name_templates"
    boss_name_source = assets.lua_sources([boss_names], decompiler)[boss_names]
    for breed in breeds:
        if "boss_name_template" not in breed:
            continue
        names, = read_tables("select:boss_name_templates." + breed["boss_name_template"], [boss_name_source])
        if isinstance(names, str):
            breed["display_name"] = names
        elif len(names) == 1:
            breed["display_name"] = names[0]
    result["breeds"] = {entry["name"]: entry for entry in breeds}
    missing = breed_names - result["breeds"].keys()
    if missing:
        raise ValueError(f"Missing terror-event breed definitions: {sorted(missing)}")
    return result
