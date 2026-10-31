"""Assemble level instances and statically configured component child units."""

import numpy as np

from ..formats.level import components, key32
from ..formats.resource import murmur64
from ..transforms import placement_matrix
from ..formats.unit_geometry import node_matrices

PROP_COMPONENT = "LevelPropCustomization"


def walk_levels(root, levels, parent=None, ancestry=(), stack=()):
    if root in stack:
        raise ValueError(f"Cyclic nested level references: {stack} -> {root}")
    parent = np.eye(4) if parent is None else parent
    yield root, levels[root], parent, ancestry
    for child in levels[root]["nested"]:
        yield from walk_levels(child["resource"], levels, parent @ placement_matrix(child),
                               (*ancestry, child["id"]), (*stack, root))


def instance_config(unit, defaults):
    return {**defaults.get(unit["resource"], {}), **unit["config"]}


def scripted_anchor(config):
    identifier = config.get((key32("directional_unit_identifier"),))
    if not identifier:
        return None
    references = [value for path, value in config.items()
                  if path[-1] == key32("resource")
                  and config.get((*path[:-1], key32("type"))) == "unit"]
    if len(references) > 1:
        raise ValueError(f"Scripted anchor {identifier} has ambiguous attached resources")
    return {"identifier": identifier, "resource": references[0] if references else None,
            "unit_template": config.get((key32("attached_unit_settings"), key32("unit_template"))),
            "spawn_group": config.get((key32("attached_unit_settings"), key32("spawn_group")))}


def prop_node_resources(levels, defaults):
    return {unit["resource"] for level in levels.values() for unit in level["units"]
            if any(component["name"] == PROP_COMPONENT for component in components(instance_config(unit, defaults)))}


def child_specs(component, defaults):
    data = component["data"]
    root = key32("children_units")
    indices = sorted({path[1] for path in data if len(path) > 1 and path[0] == root})
    if indices and indices != list(range(indices[-1] + 1)):
        raise ValueError("Sparse LevelPropCustomization child array")
    for index in indices:
        prefix = (root, index)
        value = lambda field: data.get(prefix + (key32(field),), defaults[field])
        name = data.get(prefix + (key32("child_unit"), key32("resource")), defaults["child_unit"])
        enabled, static = value("enabled"), value("is_static")
        if not isinstance(enabled, bool) or not isinstance(static, bool):
            raise ValueError("Invalid LevelPropCustomization child flags")
        if not enabled or not name:
            continue
        yield {"index": index, "name": name, "static": static, "node": value("parent_node_name"),
               "scale": [data.get(prefix + (key32("child_scale"), axis), defaults["child_scale"][axis]) for axis in range(3)]}


class SceneAssets:
    def __init__(self, defaults, collision, geometry, resources, child_defaults):
        self.defaults, self.collision, self.geometry = defaults, collision, geometry
        self.resources, self.child_defaults = resources, child_defaults

    def children(self, record, attached):
        for component in attached:
            if component["name"] != PROP_COMPONENT:
                continue
            specs = list(child_specs(component, self.child_defaults))
            if not specs:
                continue
            nodes = node_matrices(self.geometry[record["resource"]], record["node_overrides"])
            if not nodes:
                raise ValueError(f"{record['resource']}: component parent has no attachment nodes")
            for spec in specs:
                identity = f"{murmur64(spec['name']):016x}"
                if identity not in self.resources:
                    raise ValueError(f"Missing component child resource: {spec['name']}")
                # The component uses node 1 when its configured attachment node is absent.
                pose = nodes.get(key32(spec["node"]), next(iter(nodes.values())))
                matrix = np.array(record["transform"]) @ pose @ np.diag([*spec["scale"], 1])
                yield {"unit": f"{record['unit']}/child-{component['id']}-{spec['index']}", "resource": identity,
                       "level": record["level"], "ancestry": record["ancestry"],
                       "position": matrix[:3, 3].tolist(), "transform": matrix.tolist(), "node_overrides": [],
                       "physics_disabled": not spec["static"], "create_actors": spec["static"], "components": [],
                       "conditional_actors": [],
                       "spawn": {"parent": record["unit"], "component": PROP_COMPONENT, "index": spec["index"]}}

    def objects(self, root, levels):
        records = []
        for level_hash, level, parent, ancestry in walk_levels(root, levels):
            for unit in level["units"]:
                config = instance_config(unit, self.defaults)
                attached = components(config)
                anchor = scripted_anchor(config)
                if not attached and unit["resource"] not in self.collision and not anchor:
                    continue
                physics_disabled = config.get((key32("disable_physics"),), False)
                if not isinstance(physics_disabled, bool):
                    raise ValueError(f"{unit['id']}: disable_physics must be a boolean")
                matrix = parent @ placement_matrix(unit)
                record = {"unit": unit["id"], "resource": unit["resource"], "level": level_hash,
                          "ancestry": list(ancestry), "position": matrix[:3, 3].tolist(), "transform": matrix.tolist(),
                          "node_overrides": unit["node_overrides"], "volume_overrides": unit["volume_overrides"],
                          "physics_disabled": physics_disabled,
                          "create_actors": False,
                          "conditional_actors": [],
                          "components": [{"id": component["id"], "name": component["name"],
                                          "data": [[list(path), value] for path, value in component["data"].items()]}
                                         for component in attached]}
                if anchor:
                    record["scripted"] = anchor
                records.append(record)
                records.extend(self.children(record, attached))
        return records
