"""Export static navigation, complete main paths, and scene component placements."""

import time
from collections import Counter
from pathlib import Path

from .formats.level import components, read_level
from .source.lua_data import read_tables
from .formats.navdata import RuntimeStitchRequired, decode_navmesh
from .source.resources import Resources, file_digest
from .source.metadata import mission_templates, map_metadata
from .json_io import write_json
from .formats.resource import murmur64, read_package
from .formats.unit_data import read_unit_data
from .scene.objects import SceneAssets, prop_node_resources, walk_levels
from .scene.initialization import initialize_scene
from .markers.base import build_markers
from .markers.details import detail_text_keys, enrich_marker_details
from .markers.settings import COMPONENT_SOURCES, load_marker_settings
from .markers.extra import build_extra_markers
from .markers.flow import MarkerFlow
from .markers.report import write_marker_report
from .scene.main_path import prepare_main_path
from .source.localization import read_strings
from .formats.physics import read_physics
from .terrain.collisions import export_collision, resource_names
from .scene.physics import PhysicsControls

ONBOARDING_VARIANTS = {"om_hub_01", "om_hub_02", "om_basic_combat_01"}


def extract(args):
    started = time.monotonic()
    game = Path(args.game).resolve()
    identity = {"executableSha256": file_digest(game / "binaries/Darktide.exe"),
                "bundleDatabaseSha256": file_digest(game / "bundle/bundle_database.data")}
    cache = Path(args.cache).resolve() / identity["bundleDatabaseSha256"][:16]
    assets = Resources(game, args.limn, cache)
    output = args.work
    output.mkdir(parents=True, exist_ok=False)
    (output / "missions").mkdir()
    missions = mission_templates(assets, Path(args.decompiler).resolve())
    fixed = {name: data for name, data in missions.items()
             if data["mechanism_name"] != "expedition" and name not in ONBOARDING_VARIANTS}
    excluded = [{"id": name, "reason": "onboarding_variant" if name in ONBOARDING_VARIANTS else "procedurally_assembled_level"}
                for name in missions if name not in fixed]
    if args.missions:
        requested = set(args.missions)
        unknown = requested - fixed.keys()
        if unknown:
            raise ValueError(f"Unknown or procedural missions: {sorted(unknown)}")
        fixed = {name: data for name, data in fixed.items() if name in requested}
    localization = assets.extract("strings", ["content/localization/ui"])
    metadata, zones = map_metadata(assets, Path(args.decompiler).resolve(), fixed,
                                 localization[murmur64("content/localization/ui")])
    packages = assets.extract("package", {mission["level"] for mission in fixed.values()})
    dependencies = {name: read_package(packages[murmur64(mission["level"])]) for name, mission in fixed.items()}
    extracted = {}
    for kind in ("level", "NavData", "unit"):
        hashes = {name for entries in dependencies.values() for type_hash, name in entries if type_hash == murmur64(kind)}
        extracted[kind] = assets.extract(kind, hashes)
    levels = {f"{name:016x}": read_level(path) for name, path in extracted["level"].items()}
    unit_defaults = {}
    controls = PhysicsControls(assets)
    for path in extracted["unit"].values():
        name, data, flow = read_unit_data(path)
        controls.add_unit(f"{name:016x}", flow)
        if data:
            unit_defaults[f"{name:016x}"] = data
    prop_source = "scripts/components/level_prop_customization"
    marker_sources = [f"scripts/components/{file}" for file in COMPONENT_SOURCES.values()]
    source_names = [*marker_sources, prop_source]
    setting_sources = {
        "pickup": "scripts/settings/pickup/pickup_settings",
        "monster": "scripts/settings/monster/monster_settings",
        "havoc": "scripts/settings/havoc/havoc_mutator_local_settings",
        "spawner": "scripts/settings/mutator/mutator_monster_spawner_settings",
    }
    main_paths = {name: mission["level"] + "_main_path" for name, mission in fixed.items()
                  if (murmur64("lua"), murmur64(mission["level"] + "_main_path")) in dependencies[name]}
    sources = assets.lua_sources([*source_names, *main_paths.values(), *setting_sources.values()], Path(args.decompiler).resolve())
    definitions = dict(zip(COMPONENT_SOURCES, read_tables("component", [sources[name] for name in marker_sources]), strict=True))
    marker_settings = load_marker_settings(assets, Path(args.decompiler).resolve(), fixed)
    prop_definition, = read_tables("select:LevelPropCustomization.component_data.children_units.definition", [sources[prop_source]])
    child_defaults = {name: field["value"] for name, field in prop_definition.items()}
    paths = {mission: prepare_main_path(mission, data) for mission, data in
             zip(main_paths, read_tables("table", [sources[name] for name in main_paths.values()]), strict=True)}
    settings = {}
    for name, category, selector in [
        ("pool_types", "pickup", "pickup_settings.pool_types"),
        ("event_types", "pickup", "pickup_settings.event_types"),
        ("monster_distance", "monster", "monster_settings.spawn_distance"),
        ("havoc_distance", "havoc", "havoc_mutator_local_settings.mutator_havoc_twins_settings.trigger_distance"),
        ("havoc_locations", "spawner", "MutatorMonsterSpawnerSettings.default_locations"),
    ]:
        settings[name], = read_tables(f"select:{selector}", [sources[setting_sources[category]]])
    marker_resources = {name for name, data in unit_defaults.items()
                        if any(component["name"] in definitions for component in components(data))}
    physics_path, = assets.extract("physics_properties", ["application_settings/global"]).values()
    physics = read_physics(physics_path)
    names = resource_names(args.dictionary, extracted["unit"].keys()) if args.dictionary else {}
    node_resources = marker_resources | prop_node_resources(levels, unit_defaults)
    collision_catalog, geometry, collision_stats = export_collision(extracted["unit"], output, physics, names, node_resources)
    write_json(output / "physics.json", physics)
    write_json(output / "collision_units.json", collision_catalog)
    scene_assets = SceneAssets(unit_defaults, collision_catalog, geometry,
                               {f"{key:016x}" for key in extracted["unit"]}, child_defaults)
    reports = []
    for name, mission in fixed.items():
        root = f"{murmur64(mission['level']):016x}"
        scene = scene_assets.objects(root, levels)
        initialization = initialize_scene(root, levels, scene)
        physics_controls = controls.apply(root, levels, scene, definitions)
        nav_names = {int(nav["resource"], 16) for _, level, _, _ in walk_levels(root, levels) for nav in level["navigation"]}
        expected = {resource for kind, resource in dependencies[name] if kind == murmur64("NavData")}
        if nav_names != expected:
            raise ValueError(f"{name}: level navigation references do not match package dependencies")
        report = {"id": name, "scene_units": len(scene),
                  "component_children": sum("spawn" in unit for unit in scene),
                  "scene_initialization": initialization,
                  "physics_controls": physics_controls,
                  "physics_disabled_units": sum(unit["physics_disabled"] for unit in scene),
                  "collision_units": sum(unit["resource"] in collision_catalog for unit in scene),
                  "components": dict(Counter(component["name"] for unit in scene for component in unit["components"]))}
        try:
            mesh = decode_navmesh(name, [extracted["NavData"][key] for key in nav_names])
        except RuntimeStitchRequired as error:
            report["navigation_error"] = str(error)
        else:
            report["navigation"] = mesh["stats"]
        if name in paths:
            report["path_segments"] = len(paths[name]["main_path_segments"])
            report["crossroads"] = paths[name]["crossroads"]
        markers = build_markers(name, scene, geometry, definitions, settings, paths.get(name))
        extra, marker_diagnostics = build_extra_markers(mission, scene, geometry, definitions, marker_settings,
            MarkerFlow(root, levels, scene, controls.units), unit_defaults)
        for family, pins in extra.items():
            markers.setdefault(family, []).extend(pins)
        report["marker_semantics"] = marker_diagnostics
        text_keys = {pin[key] for pins in markers.values() for pin in pins
                     for key in ("name_loca_key", "description_loca_key") if key in pin and pin[key].startswith("loc_")}
        text_keys.update(entry["name"] for group in ("objectives", "locations") for entry in marker_diagnostics[group]
                         if entry.get("name", "").startswith("loc_"))
        text_keys.update(detail_text_keys(markers, scene, definitions, marker_settings["pickups"]))
        text = read_strings(localization[murmur64("content/localization/ui")], text_keys)
        for group in ("objectives", "locations"):
            for entry in marker_diagnostics[group]:
                if "name" in entry:
                    key = entry["name"]
                    entry["name_key"] = key
                    entry["name"] = text[key] if key.startswith("loc_") else key
        for pins in markers.values():
            for pin in pins:
                for field in ("name", "description"):
                    if field + "_loca_key" in pin:
                        key = pin.pop(field + "_loca_key")
                        pin[field] = text[key] if key.startswith("loc_") else key
        enrich_marker_details(markers, scene, geometry, definitions, marker_settings["pickups"], text)
        if "navigation" in report:
            write_json(output / "missions" / f"{name}.json", {
                "id": name, "navmesh": mesh, "scene": scene, "markers": markers, "mainPath": paths.get(name),
                "metadata": metadata[name],
            })
        report["marker_candidates"] = {family: len(pins) for family, pins in markers.items()}
        reports.append(report)
        print(f"{name}: {report.get('navigation', report.get('navigation_error'))}, {len(scene)} scene objects", flush=True)
    plan = {"format": "static-map-build-v2", "source": identity, "zones": zones, "missions": reports, "excluded": excluded, "collision": collision_stats,
            "havocTriggerDistance": settings["havoc_distance"], "complete": False,
            "extractSeconds": time.monotonic() - started}
    write_json(output / "build.json", plan)
    write_marker_report(plan, {name: data["title"] for name, data in metadata.items()},
                        output / "marker_regions.md")
    failures = [f"{report['id']}: {report['navigation_error']}" for report in reports if "navigation_error" in report]
    if failures:
        raise RuntimeStitchRequired("Offline navigation export incomplete:\n" + "\n".join(failures))
    return plan
