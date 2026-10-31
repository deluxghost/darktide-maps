"""Recognize authored boolean physics switches and their mission event wiring."""

from collections import deque

from ..formats.binary import Binary, resource
from ..formats.flow import CompiledFlow
from ..formats.level import key32
from ..formats.resource import murmur64
from .objects import walk_levels
from ..config import configuration
from .components import component_value

STATE_VALUE = key32("out_value")
UNIT_SPAWNED = key32("unit_spawned")
SWITCH_NODES = {0, 7, 23, 27, 35, 37, 141, 142, 157}


def node_kinds(static):
    reader = Binary(static, "unit Flow classification")
    header = reader.unpack("<23I", 0)
    if header[0] != 0 or header[2] != 92 or header[21] != len(static):
        raise ValueError("Unsupported unit Flow classification header")
    slots = reader.unpack(f"<{header[1]}I", header[2])
    # Switch recognition requires concrete executable nodes for every slot.
    if any(offset == len(static) for offset in slots):
        return set()
    return {reader.unpack("<I", offset)[0] for offset in slots}


def property_bindings(flow, offset, output=False):
    count, start = flow.words(offset + (56 if output else 48), 2)
    return {name: (storage, size) for name, storage, size in
            (flow.words(start + index * 12, 3) for index in range(count))}


def destruction_actors(flow):
    self_slots = {flow.words(o + 8, 1)[0] for o, n in flow.nodes.items() if n["kind"] == 27}
    pending = list(flow.events.get(key32("lua_last_destruction"), []))
    seen, actors = set(), set()
    while pending:
        offset = pending.pop()
        if offset in seen:
            continue
        seen.add(offset)
        kind = flow.nodes[offset]["kind"]
        if kind == 0 and flow.boolean(flow.words(offset + 8, 1)[0]):
            continue
        if kind == 142:
            unit_slot, actor_slot = flow.words(offset + 8, 2)
            if unit_slot in self_slots:
                actors.add(key32(flow.string(flow.dynamic, actor_slot)[0]))
        elif kind == 52:
            value = flow.boolean(flow.words(offset + 8, 1)[0])
            yes, end = flow.links(offset + 12)
            no, _ = flow.links(end)
            pending.extend(o for o, _ in yes if value)
            pending.extend(o for o, _ in no if not value)
            continue
        elif kind not in (0, 6, 41):
            continue
        pending.extend(o for o, _ in flow.outgoing(offset))
    return actors


class StateTransitions:
    def __init__(self, flow):
        self.flow = flow
        self.scripts = {offset: flow.script(offset) for offset, node in flow.nodes.items() if node["kind"] == 17}
        functions = {name for script in self.scripts.values() for name in script["functions"]}
        self.is_state = "FlowCallbacks.change_networked_flow_state" in functions
        self.mutable = {storage for storage, _ in flow.variables.values()}
        self.mutable.update(storage for script in self.scripts.values() for _, storage in script["outputs"].values())

    def resolve(self, event):
        flow, value, outputs = self.flow, None, set()
        pending = deque((offset, 0) for offset in flow.events.get(event, []))
        seen = set()
        while pending:
            offset, selector = pending.popleft()
            if (offset, selector) in seen:
                continue
            seen.add((offset, selector))
            kind = flow.nodes[offset]["kind"]
            if kind == 0:
                variable, = flow.words(offset + 8, 1)
                if flow.boolean(variable):
                    continue
            elif kind == 17:
                script = self.scripts[offset]
                name = script["functions"][selector]
                if name == "FlowCallbacks.change_networked_flow_state":
                    data_type, storage = script["inputs"]["in_value"]
                    if data_type != 6 or storage in self.mutable:
                        return None
                    changed = flow.boolean(storage)
                    if value is not None and value != changed:
                        raise ValueError("Conflicting constant Flow state transitions")
                    value = changed
                elif name != "FlowCallbacks.get_networked_flow_state":
                    return None
            elif kind == 23:
                name, = flow.words(offset + 8, 1)
                outputs.add(name)
                continue
            elif kind != 41:
                raise ValueError(f"Unsupported boolean state control node {kind}")
            pending.extend(flow.outgoing(offset))
        return None if value is None else (value, outputs)


class UnitStateControl:
    def __init__(self, flow, group, transitions):
        self.flow, self.group, self.transitions = flow, group, transitions
        bindings = property_bindings(flow, group, True)
        self.value_slot, size = bindings[STATE_VALUE]
        if size != 4:
            raise ValueError("Boolean Flow output has a non-boolean storage size")
        self_slots = {flow.words(offset + 8, 1)[0] for offset, node in flow.nodes.items() if node["kind"] == 27}
        for offset, node in flow.nodes.items():
            if node["kind"] in (141, 142) and flow.words(offset + 8, 1)[0] not in self_slots:
                raise ValueError("Unit physics switch controls an external unit")
        self.events = {}
        for event in flow.events:
            if event == UNIT_SPAWNED:
                continue
            effect = self.resolve(event)
            if effect is not None:
                self.events[event] = effect

    def resolve(self, event):
        flow, states, outputs = self.flow, {}, set()
        unknown = False

        def visit(offset, selector, value=None, path=()):
            nonlocal unknown
            state = offset, selector, value
            if state in path:
                raise ValueError("Cyclic boolean unit Flow control")
            path = (*path, state)
            kind = flow.nodes[offset]["kind"]
            if kind == 0:
                variable, = flow.words(offset + 8, 1)
                if flow.boolean(variable):
                    return
            elif kind == 37:
                if selector == 65535:
                    return
                if offset != self.group:
                    raise ValueError("Unexpected nested boolean Flow group")
                names = flow.event_names(offset)
                transition = self.transitions.resolve(names[selector])
                if transition is None:
                    unknown = True
                    return
                value, emitted = transition
                for name, links in flow.event_outputs(offset).items():
                    if name in emitted:
                        for target, port in links:
                            visit(target, port, value, path)
                return
            elif kind == 35:
                left_type, left, right_type, right = flow.words(offset + 8, 4)
                if (left_type, right_type) != (6, 6) or value is None:
                    raise ValueError(f"{flow.static.name}: unresolved boolean unit Flow comparison at {offset}")
                read = lambda slot: value if slot == self.value_slot else flow.boolean(slot)
                yes, end = flow.links(offset + 24)
                no, _ = flow.links(end)
                for target, port in yes if read(left) == read(right) else no:
                    visit(target, port, value, path)
                return
            elif kind in (141, 142):
                _, actor_slot = flow.words(offset + 8, 2)
                actor, _ = flow.string(flow.dynamic, actor_slot)
                states[key32(actor)] = kind == 141
            elif kind == 23:
                name, = flow.words(offset + 8, 1)
                outputs.add(name)
                return
            elif kind in (27, 157):
                return
            elif kind != 41:
                raise ValueError(f"Unsupported unit physics control node {kind}")
            for target, port in flow.outgoing(offset):
                visit(target, port, value, path)

        for offset in flow.events[event]:
            visit(offset, 0)
        if unknown:
            return None
        return {"disabled": {actor for actor, enabled in states.items() if not enabled}, "outputs": outputs}


class PhysicsControls:
    def __init__(self, resources):
        self.resources, self.shared, self.units = resources, {}, {}
        self.transient_actors = {}
        self.destruction_actors = {}

    def add_unit(self, identity, buffers):
        static, dynamic = buffers
        if not static:
            return
        kinds = node_kinds(static)
        if 142 in kinds:
            self.destruction_actors[identity] = destruction_actors(CompiledFlow(static, dynamic, f"{identity}: destruction Flow"))
        if identity in configuration("build")["collision"]["transientActorResources"]:
            transient = CompiledFlow(static, dynamic, f"{identity}: transient actor Flow")
            slots = {transient.words(o + 8, 1)[0] for o, n in transient.nodes.items() if n["kind"] == 27}
            self.transient_actors[identity] = {key32(transient.string(transient.dynamic, transient.words(o + 12, 1)[0])[0])
                for o, n in transient.nodes.items() if n["kind"] == 142 and transient.words(o + 8, 1)[0] in slots}
        if not kinds or not kinds <= SWITCH_NODES or 37 not in kinds or 35 not in kinds:
            return
        flow = CompiledFlow(static, dynamic, f"{identity}: unit Flow")
        groups = [offset for offset, node in flow.nodes.items() if node["kind"] == 37]
        if len(groups) != 1:
            return
        group = groups[0]
        low, high = flow.words(group + 8, 2)
        reference = low | high << 32
        if reference not in self.shared:
            path, = self.resources.extract("flow", [reference]).values()
            _, reader = resource(path, murmur64("flow"))
            header = reader.unpack("<23I", 0)
            self.shared[reference] = StateTransitions(CompiledFlow(reader.data[:header[21]],
                reader.data[header[21]:header[21] + header[22]], path))
        transitions = self.shared[reference]
        if transitions.is_state and STATE_VALUE in property_bindings(flow, group, True):
            self.units[identity] = UnitStateControl(flow, group, transitions)

    def apply(self, root, levels, scene, definitions):
        instances = {ancestry: level for _, level, _, ancestry in walk_levels(root, levels)}
        objects = {(tuple(unit["ancestry"]), unit["unit"]): unit for unit in scene}
        pending, parents, sources, reports = deque(), {}, {}, []
        for unit in scene:
            disabled = set(self.transient_actors.get(unit["resource"], ()))
            destructible = next((c for c in unit["components"] if c["name"] == "Destructible"), None)
            if destructible and component_value(destructible, definitions, "start_enabled"):
                disabled.add(key32("c_destructible"))
                disabled.update(key32(actor) for actor in component_value(destructible, definitions, "collision_actors"))
                disabled.update(self.destruction_actors.get(unit["resource"], ()))
            if disabled:
                unit["conditional_actors"] = sorted(set(unit["conditional_actors"]) | disabled)
                reports.append({"unit": unit["unit"], "ancestry": unit["ancestry"], "actors": sorted(disabled),
                    "source": {"resource_actor_rule": unit["resource"]}, "route": []})

        def push(ancestry, links, parent, source=None):
            for offset, selector in links:
                if selector == 65535:
                    continue
                key = ancestry, offset, selector
                if key not in parents:
                    parents[key] = parent
                    if source is not None:
                        sources[key] = source
                    pending.append(key)

        def record_effect(record, actors, key, event=None, removed=False):
            if removed:
                for unit in scene:
                    if unit["ancestry"] == record["ancestry"] and (unit["unit"] == record["unit"] or unit["unit"].startswith(record["unit"] + "/")):
                        unit["physics_disabled"] = True
            else:
                record["conditional_actors"] = sorted(set(record["conditional_actors"]) | actors)
            route, step = [], key
            while step is not None:
                route.append({"ancestry": list(step[0]), "node": step[1], "input": step[2]})
                source = sources.get(step)
                step = parents[step]
            report = {"unit": record["unit"], "ancestry": record["ancestry"], "actors": sorted(actors),
                      "source": source, "route": route[::-1]}
            if event is not None:
                report["event"] = f"{event:08x}"
            if removed:
                report["unit_removed"] = True
            reports.append(report)

        initial = instances[()]["flow"]
        for event, offsets in initial.events.items():
            push((), [(offset, 0) for offset in offsets], None, {"event": f"{event:08x}"})
        # Mission-root units define possible gameplay callbacks, not a captured state.
        for offset in initial.unit_bindings:
            if initial.nodes[offset]["kind"] != 10:
                continue
            for event, links in initial.event_outputs(offset).items():
                push((), links, None, {"node": offset, "output": f"{event:08x}"})
        callback_resources = configuration("build")["collision"]["gameplayCallbackResources"]
        for ancestry, level in instances.items():
            flow = level["flow"]
            if not ancestry:
                continue
            for offset, indices in flow.unit_bindings.items():
                if flow.nodes[offset]["kind"] != 10:
                    continue
                units = [objects.get((ancestry, level["units"][index]["id"])) for index in indices]
                if not any(unit and (unit["resource"] in callback_resources or any(
                    c["name"] == "Trigger" and component_value(c, definitions, "start_active")
                    for c in unit["components"])) for unit in units):
                    continue
                for event, links in flow.event_outputs(offset).items():
                    push(ancestry, links, None, {"node": offset, "output": f"{event:08x}", "gameplay_callback": True})
        while pending:
            ancestry, offset, selector = key = pending.popleft()
            level, flow = instances[ancestry], instances[ancestry]["flow"]
            kind = flow.nodes[offset]["kind"]
            if kind == 10:
                for index in flow.unit_bindings.get(offset, []):
                    unit = level["units"][index]
                    control = self.units.get(unit["resource"])
                    if control is None:
                        continue
                    event_names = flow.event_names(offset)
                    if selector >= len(event_names):
                        raise ValueError(f"Invalid physics-control input {key}: {event_names}")
                    name = event_names[selector]
                    if name not in control.events:
                        continue
                    effect = control.events[name]
                    if effect["disabled"]:
                        record = objects[ancestry, unit["id"]]
                        record_effect(record, effect["disabled"], key, name)
                    for output, links in flow.event_outputs(offset).items():
                        if output in effect["outputs"]:
                            push(ancestry, links, key)
                continue
            if kind in (21, 142):
                slot, = flow.words(offset + 8, 1)
                actor_slot = flow.words(offset + 12, 1)[0] if kind == 142 else None
                if slot == 0xFFFFFFFF or actor_slot == 0xFFFFFFFF:
                    if kind == 142:
                        push(ancestry, flow.outgoing(offset), key)
                    continue
                actors = {key32(flow.string(flow.dynamic, actor_slot)[0])} if kind == 142 else set()
                for binding, indices in flow.unit_bindings.items():
                    if flow.nodes[binding]["kind"] not in (10, 27) or flow.words(binding + 8, 1)[0] != slot:
                        continue
                    for index in indices:
                        record = objects.get((ancestry, level["units"][index]["id"]))
                        if record:
                            record_effect(record, actors, key, removed=kind == 21)
                push(ancestry, flow.outgoing(offset), key)
                continue
            if kind == 284:
                event = flow.event_names(offset)[selector]
                for index in flow.level_bindings.get(offset, []):
                    child = (*ancestry, level["nested"][index]["id"])
                    push(child, [(target, 0) for target in instances[child]["flow"].events.get(event, [])], key)
                continue
            if kind == 0 and flow.boolean(flow.words(offset + 8, 1)[0]):
                continue
            if kind in (19, 20) and selector != 0:
                continue
            if kind in (0, 1, 6, 17, 19, 20, 31, 35, 41, 52, 283):
                push(ancestry, flow.outgoing(offset), key)
        return {"units": len({(tuple(entry["ancestry"]), entry["unit"]) for entry in reports}), "routes": reports}
