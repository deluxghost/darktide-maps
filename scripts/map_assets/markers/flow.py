"""Locate authored spatial sources and HUD objectives in mission Flow wiring."""

from collections import defaultdict, deque

from ..formats.level import key32
from ..formats.flow import EVENT_CONTROL_NODES, FlowNode, FlowValueType, GateInput, VARIABLE_EXCHANGE
from ..scene.objects import walk_levels


class MarkerFlow:
    def __init__(self, root, levels, scene, unit_controls):
        self.instances = {ancestry: level for _, level, _, ancestry in walk_levels(root, levels)}
        self.objects = {(tuple(unit["ancestry"]), unit["unit"]): unit for unit in scene}
        self.unit_controls = unit_controls
        self.reverse = defaultdict(list)
        self.scripts, self.unit_inputs = [], defaultdict(set)
        self.build()

    def connect(self, ancestry, source, links):
        flow = self.instances[ancestry]["flow"]
        for offset, selector in links:
            if selector == VARIABLE_EXCHANGE or flow.nodes[offset]["kind"] in (FlowNode.ONCE, FlowNode.GATE) and selector != GateInput.IN:
                continue
            self.reverse[ancestry, offset].append((source, selector, None))
            if flow.nodes[offset]["kind"] == FlowNode.UNIT_EVENT:
                for index in flow.unit_bindings.get(offset, []):
                    unit = self.instances[ancestry]["units"][index]
                    self.unit_inputs[ancestry, unit["id"]].add((offset, selector))

    def events_for(self, unit):
        ancestry = tuple(unit["ancestry"])
        flow = self.instances[ancestry]["flow"]
        return {flow.event_names(offset)[selector] for offset, selector in self.unit_inputs[ancestry, unit["unit"]]}

    def build(self):
        for ancestry, level in self.instances.items():
            flow = level["flow"]
            for offset, node in flow.nodes.items():
                source = ancestry, offset
                kind = node["kind"]
                if kind == FlowNode.SCRIPT:
                    self.scripts.append((source, flow.script(offset)))
                if kind in EVENT_CONTROL_NODES:
                    self.connect(ancestry, source, flow.outgoing(offset))
                elif kind == FlowNode.UNIT_EVENT:
                    for event, links in flow.event_outputs(offset).items():
                        self.connect(ancestry, (*source, event), links)
                elif kind == FlowNode.LEVEL_EVENT:
                    for index in flow.level_bindings.get(offset, []):
                        child = (*ancestry, level["nested"][index]["id"])
                        nested = self.instances[child]["flow"]
                        for selector, event in enumerate(flow.event_names(offset)):
                            for target in nested.events.get(event, []):
                                self.reverse[child, target].append((source, 0, selector))
                        for event, links in flow.event_outputs(offset).items():
                            for terminal, terminal_node in nested.nodes.items():
                                if terminal_node["kind"] == FlowNode.OUTPUT_EVENT and nested.words(terminal + 8, 1)[0] == event:
                                    self.connect(ancestry, (child, terminal), links)

    def spatial_sources(self, start, selector):
        pending, seen, found = deque([(start, selector)]), set(), {}
        while pending:
            key, port = pending.popleft()
            if (key, port) in seen:
                continue
            seen.add((key, port))
            ancestry, offset = key[:2]
            level = self.instances[ancestry]
            flow = level["flow"]
            if key != start and flow.nodes[offset]["kind"] == FlowNode.UNIT_EVENT:
                transparent = set()
                for index in flow.unit_bindings.get(offset, []):
                    unit = level["units"][index]
                    control = self.unit_controls.get(unit["resource"])
                    if control is not None and len(key) == 3:
                        transparent.update(event for event, effect in control.events.items() if key[2] in effect["outputs"])
                    record = self.objects.get((ancestry, unit["id"]))
                    if record:
                        kinds = {component["name"] for component in record["components"]}
                        if "NetworkedTimer" in kinds:
                            transparent.add(key32("start"))
                            continue
                        if "CinematicScene" in kinds:
                            transparent.add(key32("play_cutscene"))
                            continue
                        found[ancestry, unit["id"]] = record
                if transparent:
                    allowed = {i for i, event in enumerate(flow.event_names(offset)) if event in transparent}
                    for source, input_port, source_port in self.reverse[ancestry, offset]:
                        if input_port in allowed:
                            pending.append((source, source_port))
                continue
            for source, input_port, source_port in self.reverse[key]:
                if port is None or port == input_port:
                    pending.append((source, source_port))
        return list(found.values())

    def objectives(self):
        result = defaultdict(list)
        for key, script in self.scripts:
            function = "FlowCallbacks.start_mission_objective"
            if function not in script["functions"]:
                continue
            kind, storage = script["inputs"]["objective_name"]
            if kind != FlowValueType.STRING:
                raise ValueError("Mission objective Flow name is not a string")
            flow = self.instances[key[0]]["flow"]
            name, _ = flow.string(flow.dynamic, storage)
            result[name].extend(self.spatial_sources(key, script["functions"].index(function)))
        return result
