"""Read mission titles and region names from the game's own settings and strings."""

from ..config import configuration
from .localization import read_strings
from .lua_data import read_tables


def mission_templates(assets, decompiler):
    registry = "scripts/settings/mission/mission_templates"
    sources = assets.lua_sources([registry], decompiler)
    names, = read_tables("registry", [sources[registry]])
    if not names or len(set(names)) != len(names):
        raise ValueError("Mission registry has missing or repeated template references")
    sources = assets.lua_sources(names, decompiler)
    result = {}
    for table in read_tables("missions", [sources[name] for name in names]):
        for identity, template in table.items():
            if identity in result:
                raise ValueError(f"Duplicate mission template: {identity}")
            result[identity] = template
    return result


def map_metadata(assets, decompiler, missions, strings):
    ungrouped = set(configuration("build")["maps"]["ungroupedMissions"])
    mission_zones = {name: mission["zone_id"] for name, mission in missions.items() if name not in ungrouped}
    source_name = "scripts/settings/zones/zones"
    source = assets.lua_sources([source_name], decompiler)[source_name]
    definitions, = read_tables("select:zones", [source])
    unknown = set(mission_zones.values()) - definitions.keys()
    if unknown:
        raise ValueError(f"Unknown mission zones: {sorted(unknown)}")
    zone_keys = {zone: definitions[zone]["name"] for zone in sorted(set(mission_zones.values()))}
    text = read_strings(strings, {mission["mission_name"] for mission in missions.values()} | set(zone_keys.values()))
    metadata = {}
    for name, mission in missions.items():
        metadata[name] = {"level": mission["level"], "titleKey": mission["mission_name"], "title": text[mission["mission_name"]]}
        if name in mission_zones:
            metadata[name]["zone"] = mission_zones[name]
    return metadata, {zone: text[key] for zone, key in zone_keys.items()}
