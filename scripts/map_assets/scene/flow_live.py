"""Level Flow nodes that can run in a mission.

Nested levels are reused between missions with their whole Flow wiring, but a nested level's external events only
fire when the mission's level Flow sends them. Evidence such as "level Flow sends this door an open event" counts
only when the sending node can run in this mission. Entries:
  - the mission root level: every external event (mission scripts send them) and its level-spawned event;
  - nested levels: the level-spawned event, and external events the parent sends to that instance from a live node;
  - every level: callbacks of its units (interaction, destruction, triggers), which players can cause;
  - a live output event of a nested level makes the parent's matching level-event outputs live.
"""

from collections import deque

from ..formats.flow import FlowNode, VARIABLE_EXCHANGE
from .objects import walk_levels


def live_nodes(root, levels):
    """{ancestry: set of live node offsets} for one mission."""
    instances = {ancestry: level for _, level, _, ancestry in walk_levels(root, levels)}
    live = {ancestry: set() for ancestry in instances}
    sent = {ancestry: set() for ancestry in instances}         # external event names a parent sends
    outputs = {ancestry: set() for ancestry in instances}      # output event names a nested level emits
    pending = deque()

    def push(ancestry, offset):
        if offset not in live[ancestry]:
            live[ancestry].add(offset)
            pending.append((ancestry, offset))

    def child_index(ancestry):
        parent = instances[ancestry[:-1]]
        return next(index for index, child in enumerate(parent["nested"]) if child["id"] == ancestry[-1])

    for ancestry, level in instances.items():
        flow = level["flow"]
        for offset, node in flow.nodes.items():
            kind = node["kind"]
            if kind == FlowNode.LEVEL_SPAWNED or (kind == FlowNode.EXTERNAL_EVENT and not ancestry):
                push(ancestry, offset)
            elif kind == FlowNode.UNIT_EVENT:
                for links in flow.event_outputs(offset).values():
                    for target, selector in links:
                        if selector != VARIABLE_EXCHANGE:
                            push(ancestry, target)
    while pending:
        ancestry, offset = pending.popleft()
        level = instances[ancestry]
        flow = level["flow"]
        kind = flow.nodes[offset]["kind"]
        if kind == FlowNode.LEVEL_EVENT:
            names = set(flow.event_names(offset))
            for index in flow.level_bindings.get(offset, []):
                child = (*ancestry, level["nested"][index]["id"])
                new = names - sent[child]
                sent[child] |= new
                for event in new:
                    for target in instances[child]["flow"].events.get(event, []):
                        push(child, target)
            continue                                                # its outputs follow the child's output events
        if kind == FlowNode.OUTPUT_EVENT and ancestry:
            event, = flow.words(offset + 8, 1)
            if event not in outputs[ancestry]:
                outputs[ancestry].add(event)
                parent = ancestry[:-1]
                parent_flow = instances[parent]["flow"]
                index = child_index(ancestry)
                for binding, indices in parent_flow.level_bindings.items():
                    if index in indices and parent_flow.nodes[binding]["kind"] == FlowNode.LEVEL_EVENT:
                        for target, selector in parent_flow.event_outputs(binding).get(event, ()):
                            if selector != VARIABLE_EXCHANGE:
                                push(parent, target)
            continue
        if kind == FlowNode.UNIT_EVENT:
            continue                                                # outputs are unit callbacks, already entries
        for target, selector in flow.outgoing(offset):
            if selector != VARIABLE_EXCHANGE:
                push(ancestry, target)
    return live
