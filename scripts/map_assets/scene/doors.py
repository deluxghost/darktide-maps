"""Door classification for map obstacle carving.

Initially open doors are conditional passages; closed close_only doors remain obstacles. For other closed doors,
active configured panels, an Interactable component, or recognized Flow opening/panel-activation events make them
conditional. Flow events must come from live mission nodes or the door's player-trigger components.
Unmatched doors retain blocking collision.
"""

from collections import defaultdict

from ..formats.flow import CompiledFlow, FlowNode, FlowValueType
from ..formats.level import key32
from .objects import walk_levels

DOOR_COMPONENT = "Door"
OPEN_METHODS = {"open", "toggle_open", "open_fwd", "toggle_fwd", "open_bwd", "toggle_bwd", "interaction_success"}
COMPONENT_CALL = "FlowCallbacks.call_script_component"
FIELDS = {key32(name): name for name in ("open_type", "start_state", "control_panels_active", "control_panel_props")}
NO_LINK = 0xFFFF
PANEL_METHODS = OPEN_METHODS | {"activate_control_panels"}
DESTRUCTIBLE_COMPONENT = "Destructible"
DESTRUCT_METHODS = {"force_destruct"}
TRIGGER_COMPONENT = "Trigger"
TRIGGER_FIELDS = {key32(name): name for name in ("trigger_action", "trigger_condition", "start_active")}
TRIGGER_EVENT = key32("lua_trigger_activated")   # TriggerActionSendFlow: Unit.flow_event(volume_unit, ...)
NON_PLAYER_CONDITIONS = {"at_least_one_boss_inside"}


def trigger_events(unit):
    """Unit Flow events the unit's own Trigger components send when players enter their volume."""
    events = set()
    for component in unit["components"]:
        if component["name"] != TRIGGER_COMPONENT:
            continue
        data = {TRIGGER_FIELDS[path[0]]: value for path, value in component["data"]
                if len(path) == 1 and path[0] in TRIGGER_FIELDS}
        condition = data.get("trigger_condition", "at_least_one_player_inside")
        if data.get("trigger_action") == "send_flow" and data.get("start_active", True) \
                and condition not in NON_PLAYER_CONDITIONS:
            events.add(TRIGGER_EVENT)
    return events


def component_call(flow, offset):
    """(method, component guid) of a call_script_component node, else None."""
    script = flow.script(offset)
    if script["functions"] != [COMPONENT_CALL]:
        return None
    strings = {name: flow.string(flow.dynamic, storage)[0]
               for name, (kind, storage) in script["inputs"].items() if kind == FlowValueType.STRING}
    return strings.get("event"), strings.get("guid")


def self_open_events(buffers, component_id, methods=OPEN_METHODS):
    """Unit Flow events that lead to a call of one of methods on the unit's own component component_id."""
    static, dynamic = buffers
    if not static:
        return set()
    flow = CompiledFlow(static, dynamic, "unit Flow")
    events = set()
    for event, starts in flow.events.items():
        pending, seen = list(starts), set()
        while pending:
            offset = pending.pop()
            if offset in seen:
                continue
            seen.add(offset)
            if flow.nodes[offset]["kind"] == FlowNode.SCRIPT:
                call = component_call(flow, offset)
                if call and call[0] in methods and call[1] and f"{key32(call[1]):08x}" == component_id:
                    events.add(event)
                continue
            pending.extend(target for target, port in flow.outgoing(offset) if port != NO_LINK)
    return events


def live_sent_events(root, levels, live):
    """{(ancestry, unit id): unit event names} that live level Flow nodes of this mission send to each unit."""
    sent = defaultdict(set)
    for ancestry, level in ((ancestry, level) for _, level, _, ancestry in walk_levels(root, levels)):
        flow = level["flow"]
        for offset, node in flow.nodes.items():
            if node["kind"] == FlowNode.UNIT_EVENT and offset in live[ancestry]:
                names = set(flow.event_names(offset))
                for index in flow.unit_bindings.get(offset, []):
                    sent[ancestry, level["units"][index]["id"]] |= names
    return sent


def flow_destructed(root, levels, scene, unit_flows, live):
    """(ancestry, unit id) of Destructible instances the mission Flow breaks: a live level Flow node sends the unit an
    event on which its own unit Flow calls force_destruct on its Destructible (scripted breaches, not monsters)."""
    sent = live_sent_events(root, levels, live)
    cache, result = {}, set()
    for unit in scene:
        component = next((c for c in unit["components"] if c["name"] == DESTRUCTIBLE_COMPONENT), None)
        key = tuple(unit["ancestry"]), unit["unit"]
        if component is None or key not in sent:
            continue
        flow_key = unit["resource"], component["id"]
        if flow_key not in cache:
            cache[flow_key] = self_open_events(unit_flows.get(unit["resource"], (None, None)), component["id"],
                                               DESTRUCT_METHODS)
        if cache[flow_key] & sent[key]:
            result.add(key)
    return result


def openable_doors(root, levels, scene, unit_flows, live):
    """(ancestry, unit id) of every Door instance players can open; unit_flows: resource -> Flow buffers;
    live: {ancestry: live level Flow nodes} (flow_live), so wiring a mission never runs is no evidence."""
    sent = live_sent_events(root, levels, live)
    cache, result = {}, set()
    for unit in scene:
        door = next((component for component in unit["components"] if component["name"] == DOOR_COMPONENT), None)
        if door is None:
            continue
        config = {FIELDS[path[0]]: value for path, value in door["data"] if len(path) == 1 and path[0] in FIELDS}
        panels = any(path and path[0] == key32("control_panel_props") for path, _ in door["data"])
        key = tuple(unit["ancestry"]), unit["unit"]
        if config.get("start_state", "closed") != "closed":
            result.add(key)
            continue
        if config.get("open_type", "none") == "close_only":
            continue
        if config.get("control_panels_active", True) and panels \
                or any(component["name"] == "Interactable" for component in unit["components"]):
            result.add(key)
            continue
        flow_key = unit["resource"], door["id"], panels
        if flow_key not in cache:
            cache[flow_key] = self_open_events(unit_flows.get(unit["resource"], (None, None)), door["id"],
                                               PANEL_METHODS if panels else OPEN_METHODS)
        if cache[flow_key] & (sent.get(key, set()) | trigger_events(unit)):
            result.add(key)
    return result
