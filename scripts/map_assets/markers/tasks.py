"""Classify task actions and retain authored carry relationships."""

from collections import defaultdict

from ..scene.components import component_value


def task_key(pin):
    return pin["source"]["objective"] + "|" + pin["source"]["unit_id"]


def classify_task_markers(families, scene, definitions, pickups):
    units = {"/".join([*u["ancestry"], u["unit"]]): u for u in scene}
    tasks = [p for family in ("objectives", "interactions", "luggables") for p in families[family]
             if "objective" in p["source"]]
    for family in ("objectives", "interactions", "luggables"):
        families[family] = [p for p in families[family] if "objective" not in p["source"]]
    synchronizers = {}
    task_names = {p["source"]["objective"] for p in tasks}
    for unit in scene:
        for component in unit["components"]:
            if component["name"] != "LuggableSynchronizer":
                continue
            name = component_value(component, definitions, "objective_name")
            if name not in task_names:
                continue
            if name in synchronizers:
                raise ValueError(f"Duplicate task synchronizer: {name}")
            synchronizers[name] = component
    groups = defaultdict(list)
    for pin in tasks:
        components = {c["name"]: c for c in units[pin["source"]["unit_id"]]["components"]}
        role = "objective"
        if "MissionLuggableSpawner" in components:
            role = "carry"
            items = [p for p in component_value(components["PickupSpawner"], definitions, "items") if p != "none"]
            if len(items) != 1:
                raise ValueError(f"Task carry spawn needs an unambiguous item: {pin['source']}: {items}")
            pin.pop("name", None)
            pin["name_loca_key"] = pickups[items[0]]["description"]
        elif "LuggableSocket" in components:
            role = "destination"
        elif "Interactable" in components:
            role = "interaction"
        pin["task_role"] = role
        families["luggables" if role == "carry" else "objectives"].append(pin)
        target = components.get("MissionObjectiveTarget")
        if target:
            stage = component_value(target, definitions, "objective_stage")
            pin["objective_stage"] = stage
            groups[pin["source"]["objective"], stage].append((pin, components))
    relations = set()

    for (name, stage), entries in groups.items():
        synchronizer = synchronizers.get(name)
        if not synchronizer:
            continue
        value = lambda field: component_value(synchronizer, definitions, field)
        carried = [p for p, _ in entries if p["task_role"] == "carry"]
        targets = [p for (other_name, other_stage), other_entries in groups.items()
                   if other_name == name and (other_stage == stage or value("keep_unused_sockets") and other_stage < stage)
                   for p, _ in other_entries if p["task_role"] == "destination"]
        for source in carried:
            for target in targets:
                relations.add(("carry", task_key(source), task_key(target)))
    families["relations"] = [{"kind": kind, "from": left, "to": right} for kind, left, right in sorted(relations)]
