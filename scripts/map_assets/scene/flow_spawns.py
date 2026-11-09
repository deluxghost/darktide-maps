"""Units that a unit's own Flow spawns and links to it when the unit spawns.

Some props add parts at spawn time, e.g. a barrier spawning its fence when its unit data says has_fence. Only
spawns that every instance of the prop performs, or that depend solely on the instance's own boolean unit data,
are static scene content. Spawns reached through events, random choices or other runtime input are conditional and
not modelled. A spawned part is linked to a node of its parent and, like the parent, is not registered with any
component extension.
"""

from ..formats.binary import Binary
from ..formats.flow import CompiledFlow, FLOW_HEADER_SIZE, FlowNode, FlowValueType, VARIABLE_EXCHANGE
from ..formats.level import key32

SPAWN_UNIT = 28
SPAWN_INPUT = 0                     # the spawn node's other input removes the unit again
LINK_UNIT = 38
MAX_DEPTH = 4


def has_spawn_node(static, name):
    """Cheap node-kind scan, so Flows without spawns are never fully parsed."""
    reader = Binary(static, name)
    header = reader.unpack("<23I", 0)
    if header[0] != 0 or header[2] != FLOW_HEADER_SIZE or header[21] != len(static):
        raise ValueError(f"{name}: unsupported Flow header")
    slots = reader.unpack(f"<{header[1]}I", header[2])
    return any(offset < len(static) and reader.unpack("<I", offset)[0] == SPAWN_UNIT for offset in set(slots))


def spawn_specs(buffers, name):
    """[{"resource": name, "node": parent node hash, "conditions": ((data key, expected), ...)}] of one unit Flow."""
    static, dynamic = buffers
    if not static or not has_spawn_node(static, name):
        return []
    flow = CompiledFlow(static, dynamic, name)
    spawns = [offset for offset, node in flow.nodes.items() if node["kind"] == SPAWN_UNIT]
    if not spawns:
        return []
    starts = [offset for offset, node in flow.nodes.items() if node["kind"] == FlowNode.UNIT_SPAWNED]
    own = {flow.words(offset + 8, 1)[0] for offset in starts}       # slots holding the unit itself
    data, readers = {}, set()                                        # output slot -> unit data key
    for offset, node in flow.nodes.items():
        if node["kind"] == FlowNode.GET_UNIT_BOOLEAN_DATA:
            unit, _, _, key, output = flow.words(offset + 8, 5)
            if unit in own:
                data[output] = key32(flow.string(flow.dynamic, key)[0])
                readers.add(offset)

    def static_inputs(offset):
        """Every data node evaluated for this node only reads the instance's own unit data."""
        dependencies = flow.nodes[offset]["dependencies"]
        return not dependencies or all(target in readers for target, _ in flow.links(dependencies)[0])
    links = {}                                                       # spawned unit slot -> parent node hash
    for offset, node in flow.nodes.items():
        if node["kind"] == LINK_UNIT:
            child, _, parent, node_hash = flow.words(offset + 8, 4)
            if parent in own:
                links[child] = node_hash

    def operand(kind, slot):
        """('data', key) for the instance's boolean unit data, ('const', value), or None if unresolved."""
        if kind != FlowValueType.BOOLEAN:
            return None
        if slot in data:
            return "data", data[slot]
        return "const", flow.boolean(slot)

    result, seen = [], set()

    def visit(offset, port, conditions, path):
        if (offset, port, conditions) in path:
            return
        path = path | {(offset, port, conditions)}
        kind = flow.nodes[offset]["kind"]
        if kind in (FlowNode.COMPARE_VALUES, FlowNode.BOOLEAN_BRANCH) and not static_inputs(offset):
            return                                                   # decided by runtime data: conditional
        if kind == SPAWN_UNIT:
            if port != SPAWN_INPUT:
                return
            resource_slot, _, _, unit_slot = flow.words(offset + 8, 4)
            node_hash = links.get(unit_slot)
            if node_hash:                                            # 0: node chosen at runtime
                spec = flow.string(flow.dynamic, resource_slot)[0], node_hash, conditions
                if spec not in seen:
                    seen.add(spec)
                    result.append({"resource": spec[0], "node": node_hash, "conditions": conditions})
            targets = []
        elif kind == FlowNode.UNIT_SPAWNED:
            targets = flow.links(offset + 12)[0]
        elif kind == FlowNode.SEQUENCE:
            targets = flow.outgoing(offset)
        elif kind == FlowNode.COMPARE_VALUES:
            left_kind, left, right_kind, right = flow.words(offset + 8, 4)
            a, b = operand(left_kind, left), operand(right_kind, right)
            yes, end = flow.links(offset + 24)
            no, _ = flow.links(end)
            if a is None or b is None:
                return
            if a[0] == "const" and b[0] == "const":
                branches = [(yes if a[1] == b[1] else no, conditions)]
            elif a[0] == "const" or b[0] == "const":
                key, value = (b[1], a[1]) if a[0] == "const" else (a[1], b[1])
                branches = [(yes, conditions + ((key, value),)), (no, conditions + ((key, not value),))]
            else:
                return
            for targets, branch_conditions in branches:
                for target, port in targets:
                    if port != VARIABLE_EXCHANGE:
                        visit(target, port, branch_conditions, path)
            return
        elif kind == FlowNode.BOOLEAN_BRANCH:
            value = operand(FlowValueType.BOOLEAN, flow.words(offset + 8, 1)[0])
            yes, end = flow.links(offset + 12)
            no, _ = flow.links(end)
            if value is None:
                return
            if value[0] == "const":
                branches = [(yes if value[1] else no, conditions)]
            else:
                branches = [(yes, conditions + ((value[1], True),)), (no, conditions + ((value[1], False),))]
            for targets, branch_conditions in branches:
                for target, port in targets:
                    if port != VARIABLE_EXCHANGE:
                        visit(target, port, branch_conditions, path)
            return
        else:
            return                                                   # runtime-dependent: conditional content
        for target, port in targets:
            if port != VARIABLE_EXCHANGE:
                visit(target, port, conditions, path)

    for offset in starts:
        visit(offset, 0, (), frozenset())
    return result


def active(spec, config):
    """Whether a spawn applies to an instance; None when the instance does not set the data it depends on."""
    for key, expected in spec["conditions"]:
        value = config.get((key,))
        if not isinstance(value, bool):
            return None
        if value != expected:
            return False
    return True
