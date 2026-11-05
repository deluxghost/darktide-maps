"""Resolve authored, deterministic level-spawn routes that configure path blockers."""

from collections import defaultdict
import heapq
import math

from ..formats.level import key32
from ..formats.flow import FlowNode, GateInput, VARIABLE_EXCHANGE
from .objects import walk_levels

LEVEL_SPAWNED = key32("level_spawned")
UNIT_SPAWNED = key32("unit_spawned")
PATH_OPEN = key32("mission_path_blocker_open")
PATH_CLOSED = key32("mission_path_blocker_closed")


class InitialScene:
    def __init__(self, root, levels, scene):
        self.instances = {ancestry: level for _, level, _, ancestry in walk_levels(root, levels)}
        self.blockers = {(tuple(unit["ancestry"]), unit["unit"]): unit for unit in scene
                         if any(component["name"] == "MissionPathBlocker" for component in unit["components"])}
        for unit in self.blockers.values():
            unit["mission_path_blocker_enabled"] = True
        self.edges, self.targets = {}, {}
        self.goals = set()
        self.variables, self.changes, self.origins = {}, {}, {}
        self.queue, self.serial = [], 0
        self.build_graph()
        self.critical = self.physical_ancestors()

    def unit_targets(self, ancestry, offset):
        level = self.instances[ancestry]
        return [self.blockers[(ancestry, level["units"][index]["id"])]
                for index in level["flow"].unit_bindings.get(offset, [])
                if (ancestry, level["units"][index]["id"]) in self.blockers]

    def level_targets(self, ancestry, offset, event):
        level = self.instances[ancestry]
        result = []
        for index in level["flow"].level_bindings.get(offset, []):
            child = (*ancestry, level["nested"][index]["id"])
            for target in self.instances[child]["flow"].events.get(event, []):
                result.append((child, target))
        return result

    def build_graph(self):
        for ancestry, level in self.instances.items():
            flow = level["flow"]
            for offset, node in flow.nodes.items():
                key = ancestry, offset
                # Object output events are separate arrivals, not the result of sending an input.
                edges = set() if node["kind"] in (FlowNode.UNIT_EVENT, FlowNode.LEVEL_EVENT) else {
                    (ancestry, target) for target, selector in flow.outgoing(offset)
                    if selector != VARIABLE_EXCHANGE or flow.nodes[target]["kind"] not in (FlowNode.UNIT_EVENT, FlowNode.LEVEL_EVENT)}
                if node["kind"] == FlowNode.UNIT_EVENT:
                    targets = self.unit_targets(ancestry, offset)
                    self.targets[key] = targets
                    if targets and {PATH_OPEN, PATH_CLOSED}.intersection(flow.event_names(offset)):
                        self.goals.add(key)
                elif node["kind"] == FlowNode.LEVEL_EVENT:
                    for event in flow.event_names(offset):
                        edges.update(self.level_targets(ancestry, offset, event))
                self.edges[key] = edges

    def physical_ancestors(self):
        reverse = defaultdict(set)
        for source, targets in self.edges.items():
            for target in targets:
                reverse[target].add(source)
        critical, pending = set(self.goals), list(self.goals)
        while pending:
            for parent in reverse[pending.pop()] - critical:
                critical.add(parent)
                pending.append(parent)
        return critical

    def schedule(self, ancestry, offset, selector, time, origin, path):
        # Variable exchange does not send the first input event.
        if (selector == VARIABLE_EXCHANGE
                and self.instances[ancestry]["flow"].nodes[offset]["kind"] in (FlowNode.UNIT_EVENT, FlowNode.LEVEL_EVENT)):
            return
        if (ancestry, offset) not in self.critical:
            return
        self.serial += 1
        heapq.heappush(self.queue, (time, self.serial, ancestry, offset, selector, origin, path))

    def emit(self, ancestry, links, time, origin, path):
        for offset, selector in links:
            self.schedule(ancestry, offset, selector, time, origin, path)

    def unsupported(self, ancestry, offset, reason):
        level = self.instances[ancestry]
        kind = level["flow"].nodes[offset]["kind"]
        raise ValueError(f"{level['resource']}: unresolved physical initializer at Flow node {offset} (type {kind}): {reason}")

    def variable(self, ancestry, offset):
        key = ancestry, offset
        if key not in self.variables:
            self.variables[key] = self.instances[ancestry]["flow"].boolean(offset)
        return key

    def unit_event(self, ancestry, offset, selector, origin, path):
        flow = self.instances[ancestry]["flow"]
        names = flow.event_names(offset)
        if selector >= len(names):
            self.unsupported(ancestry, offset, "invalid unit event input")
        event = names[selector]
        if event not in (PATH_OPEN, PATH_CLOSED):
            return
        for unit in self.targets.get((ancestry, offset), []):
            key = ancestry, unit["unit"]
            enabled = event == PATH_CLOSED
            if key in self.origins and self.origins[key] != origin and unit["mission_path_blocker_enabled"] != enabled:
                self.unsupported(ancestry, offset, "conflicting level-spawn initializers")
            unit["mission_path_blocker_enabled"] = enabled
            self.origins[key] = origin
            self.changes[key] = {"unit": unit["unit"], "ancestry": list(ancestry), "enabled": enabled,
                                 "event": "mission_path_blocker_closed" if enabled else "mission_path_blocker_open",
                                 "route": [{"ancestry": list(a), "node": n, "input": s} for a, n, s in path]}

    def evaluate(self, time, ancestry, offset, selector, origin, path):
        level = self.instances[ancestry]
        flow = level["flow"]
        kind = flow.nodes[offset]["kind"]
        if flow.nodes[offset]["dependencies"]:
            self.unsupported(ancestry, offset, "runtime data dependencies")
        state = ancestry, offset, selector
        if state in path:
            self.unsupported(ancestry, offset, "cyclic scene initialization")
        path = (*path, state)
        if kind == FlowNode.UNIT_EVENT:
            self.unit_event(ancestry, offset, selector, origin, path)
            return
        if kind == FlowNode.LEVEL_EVENT:
            names = flow.event_names(offset)
            if selector >= len(names):
                self.unsupported(ancestry, offset, "invalid level event input")
            for child, target in self.level_targets(ancestry, offset, names[selector]):
                self.schedule(child, target, 0, time, origin, path)
            return
        if kind == FlowNode.EXTERNAL_EVENT:
            variable, = flow.words(offset + 8, 1)
            if flow.boolean(variable):
                return
        elif kind in (FlowNode.ONCE, FlowNode.GATE):
            variable, = flow.words(offset + 8, 1)
            key = self.variable(ancestry, variable)
            if kind == FlowNode.ONCE:
                if selector != GateInput.IN or self.variables[key]:
                    return
                self.variables[key] = True
            elif selector != GateInput.IN:
                if selector not in (GateInput.OPEN, GateInput.CLOSE, GateInput.TOGGLE):
                    self.unsupported(ancestry, offset, "invalid gate input")
                self.variables[key] = selector == GateInput.OPEN if selector != GateInput.TOGGLE else not self.variables[key]
                return
            elif not self.variables[key]:
                return
        elif kind == FlowNode.DELAY:
            variable, = flow.words(offset + 8, 1)
            delay = flow.number(variable)
            if not math.isfinite(delay) or delay < 0:
                self.unsupported(ancestry, offset, "invalid initialization delay")
            time += delay
        elif kind == FlowNode.BOOLEAN_BRANCH:
            variable, = flow.words(offset + 8, 1)
            yes, end = flow.links(offset + 12)
            no, _ = flow.links(end)
            self.emit(ancestry, yes if flow.boolean(variable) else no, time, origin, path)
            return
        elif kind not in (FlowNode.SEQUENCE, FlowNode.LEVEL_SPAWNED):
            self.unsupported(ancestry, offset, "unsupported control or callback")
        self.emit(ancestry, flow.outgoing(offset), time, origin, path)

    def resolve(self):
        for ancestry, level in self.instances.items():
            flow = level["flow"]
            for offset in flow.events.get(UNIT_SPAWNED, []):
                if (ancestry, offset) in self.critical:
                    self.unsupported(ancestry, offset, "unit-dependent spawn event")
            for offset in flow.events.get(LEVEL_SPAWNED, []):
                self.schedule(ancestry, offset, 0, 0, (ancestry, offset), ())
        while self.queue:
            time, _, ancestry, offset, selector, origin, path = heapq.heappop(self.queue)
            self.evaluate(time, ancestry, offset, selector, origin, path)
        return {"blockers": len(self.blockers), "initialized": len(self.changes),
                "open": sum(not unit["mission_path_blocker_enabled"] for unit in self.blockers.values()),
                "routes": list(self.changes.values())}


def initialize_scene(root, levels, scene):
    return InitialScene(root, levels, scene).resolve()
