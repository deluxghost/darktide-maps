"""Read compiled Flow connections, typed parameters and level object bindings."""

from enum import IntEnum

from .binary import Binary

FLOW_HEADER_SIZE = 92
LINK_SELECTOR_SHIFT = 16
LINK_SLOT_MASK = (1 << LINK_SELECTOR_SHIFT) - 1
VARIABLE_EXCHANGE = 0xFFFF
INVALID_STORAGE = 0xFFFFFFFF
MAX_SCANNED_SELECTOR = 32
SCRIPT_TABLE_FUNCTION = 1


class FlowNode(IntEnum):
    EXTERNAL_EVENT = 0
    LOG = 1
    DELAY = 6
    UNIT_SPAWNED = 7
    UNIT_EVENT = 10
    SCRIPT = 17
    ONCE = 19
    GATE = 20
    DESTROY_UNIT = 21
    OUTPUT_EVENT = 23
    SET_UNIT_VISIBILITY = 27
    COMPARE_NUMBERS = 31
    COMPARE_VALUES = 35
    GROUP = 37
    SEQUENCE = 41
    PLAY_ANIMATION = 42
    BOOLEAN_BRANCH = 52
    CREATE_ACTOR = 141
    DESTROY_ACTOR = 142
    GET_UNIT_BOOLEAN_DATA = 157
    LEVEL_SPAWNED = 283
    LEVEL_EVENT = 284


class FlowValueType(IntEnum):
    BOOLEAN = 6
    STRING = 7


class GateInput(IntEnum):
    IN = 0
    OPEN = 1
    CLOSE = 2
    TOGGLE = 3


EVENT_CONTROL_NODES = {
    FlowNode.EXTERNAL_EVENT, FlowNode.LOG, FlowNode.DELAY, FlowNode.SCRIPT,
    FlowNode.ONCE, FlowNode.GATE, FlowNode.COMPARE_NUMBERS, FlowNode.COMPARE_VALUES,
    FlowNode.SEQUENCE, FlowNode.BOOLEAN_BRANCH, FlowNode.LEVEL_SPAWNED,
}


class CompiledFlow:
    def __init__(self, static, dynamic, name):
        reader = Binary(static, name)
        header = reader.unpack("<23I", 0)
        if header[0] != 0 or header[2] != FLOW_HEADER_SIZE or header[4] != FLOW_HEADER_SIZE + header[1] * 4:
            raise ValueError(f"{reader.name}: unsupported Flow header")
        if len(static) != header[21] or len(dynamic) != header[22]:
            raise ValueError(f"{reader.name}: Flow extent mismatch")
        self.static = reader
        self.dynamic = Binary(dynamic, name)
        self.slots = self.static.unpack(f"<{header[1]}I", header[2])
        offsets = sorted(set(self.slots))
        if any(offset < header[20] or offset >= header[21] for offset in offsets):
            raise ValueError(f"{reader.name}: invalid Flow node offsets")
        self.nodes = {}
        for index, offset in enumerate(offsets):
            end = offsets[index + 1] if index + 1 < len(offsets) else header[21]
            kind, dependencies = self.static.unpack("<2I", offset)
            self.nodes[offset] = {"kind": kind, "end": end, "dependencies": dependencies}
        self.events = {}
        offset = header[4]
        for _ in range(header[3]):
            name, slot = self.static.unpack("<2I", offset)
            if slot >= len(self.slots):
                raise ValueError(f"{reader.name}: invalid Flow event slot")
            self.events.setdefault(name, []).append(self.slots[slot])
            offset += 8
        if offset + header[5] * 8 != header[7]:
            raise ValueError(f"{reader.name}: invalid Flow event tables")
        self.variables = {name: (storage, kind) for name, storage, kind in
                          (self.words(header[7] + index * 12, 3) for index in range(header[6]))}

    def words(self, offset, count):
        return self.static.unpack(f"<{count}I", offset)

    def links(self, offset):
        count, = self.words(offset, 1)
        targets = []
        for packed in self.words(offset + 4, count):
            slot, selector = packed & LINK_SLOT_MASK, packed >> LINK_SELECTOR_SHIFT
            if slot >= len(self.slots):
                raise ValueError(f"{self.static.name}: invalid Flow link slot")
            targets.append((self.slots[slot], selector))
        return targets, offset + 4 + count * 4

    def event_names(self, offset, output=False):
        base = 40 if output else 32
        if self.nodes[offset]["kind"] != FlowNode.GROUP:
            base = 20 if output else 12
        count, start = self.words(offset + base, 2)
        return self.words(start, count)

    def event_outputs(self, offset):
        start = offset + (64 if self.nodes[offset]["kind"] == FlowNode.GROUP else 44)
        result = {}
        for name in self.event_names(offset, True):
            result[name], start = self.links(start)
        return result

    @staticmethod
    def string(reader, offset):
        reader.check(offset, 1)
        end = reader.data.find(b"\0", offset)
        if end < 0:
            raise ValueError(f"{reader.name}: unterminated Flow string")
        return reader.data[offset:end].decode("utf-8"), end + 1

    def parameters(self, offset, count, align):
        result = {}
        for _ in range(count):
            kind, storage = self.words(offset, 2)
            name, offset = self.string(self.static, offset + 8)
            result[name] = kind, storage
            if align:
                offset = (offset + 3) & ~3
        return result

    def script(self, offset):
        fields = self.words(offset, 14)
        position, functions = fields[7], []
        for _ in range(fields[6]):
            mode, = self.static.unpack("<B", position)
            if mode != SCRIPT_TABLE_FUNCTION:
                raise ValueError(f"{self.static.name}: unsupported Flow script mode {mode}")
            table, position = self.string(self.static, position + 1)
            function, position = self.string(self.static, position)
            functions.append(f"{table}.{function}")
        return {"functions": functions, "inputs": self.parameters(fields[9], fields[8], True),
                "outputs": self.parameters(fields[11], fields[10], False)}

    def boolean(self, offset):
        value, = self.dynamic.unpack("<I", offset)
        if value not in (0, 1):
            raise ValueError(f"{self.static.name}: invalid Flow boolean")
        return bool(value)

    def number(self, offset):
        value, = self.dynamic.unpack("<f", offset)
        return value

    def outgoing(self, offset):
        kind = self.nodes[offset]["kind"]
        if kind in (FlowNode.EXTERNAL_EVENT, FlowNode.DELAY, FlowNode.ONCE, FlowNode.GATE, FlowNode.LEVEL_SPAWNED):
            return self.links(offset + 12)[0]
        if kind == FlowNode.LOG:
            return self.links(offset + 16)[0]
        if kind in (FlowNode.COMPARE_NUMBERS, FlowNode.COMPARE_VALUES, FlowNode.SEQUENCE, FlowNode.BOOLEAN_BRANCH):
            count, start = {FlowNode.COMPARE_NUMBERS: (5, 16), FlowNode.COMPARE_VALUES: (2, 24),
                            FlowNode.SEQUENCE: (8, 8), FlowNode.BOOLEAN_BRANCH: (2, 12)}[kind]
            start += offset
            result = []
            for _ in range(count):
                links, start = self.links(start)
                result.extend(links)
            return result
        if kind == FlowNode.PLAY_ANIMATION:
            # Animation marker callbacks are not immediate scene-initialization edges.
            started, end = self.links(offset + 48)
            stopped, _ = self.links(end)
            return [*started, *stopped]
        if kind in (FlowNode.UNIT_EVENT, FlowNode.LEVEL_EVENT, FlowNode.GROUP):
            return [link for links in self.event_outputs(offset).values() for link in links]
        if kind in (FlowNode.CREATE_ACTOR, FlowNode.DESTROY_ACTOR):
            return self.links(offset + (20 if kind == FlowNode.CREATE_ACTOR else 16))[0]
        if kind == FlowNode.DESTROY_UNIT:
            return self.links(offset + 16)[0]
        if kind in (FlowNode.OUTPUT_EVENT, FlowNode.SET_UNIT_VISIBILITY, FlowNode.GET_UNIT_BOOLEAN_DATA):
            return []
        if kind == FlowNode.SCRIPT:
            count, = self.words(offset + 48, 1)
            result, start = [], offset + 56
            for _ in range(count):
                links, start = self.links(start)
                result.extend(links)
            return result
        # Conservatively retain potential links in unmodeled native nodes. If one
        # reaches a physical initializer, evaluation fails rather than omitting it.
        data = self.words(offset + 8, (self.nodes[offset]["end"] - offset - 8) // 4)
        result = set()
        for index, count in enumerate(data):
            if not 0 < count <= len(data) - index - 1:
                continue
            candidates = data[index + 1:index + 1 + count]
            if all((value & LINK_SLOT_MASK) < len(self.slots) and
                   (value >> LINK_SELECTOR_SHIFT <= MAX_SCANNED_SELECTOR or value >> LINK_SELECTOR_SHIFT == VARIABLE_EXCHANGE)
                   for value in candidates):
                result.update((self.slots[value & LINK_SLOT_MASK], value >> LINK_SELECTOR_SHIFT) for value in candidates)
        return list(result)


class LevelFlow(CompiledFlow):
    def __init__(self, reader, unit_count, level_count):
        start, dynamic_start = reader.unpack("<2I", 36)
        header = reader.unpack("<23I", start)
        reader.check(start, header[21])
        reader.check(dynamic_start, header[22])
        super().__init__(reader.data[start:start + header[21]],
                         reader.data[dynamic_start:dynamic_start + header[22]], reader.name)
        self.unit_bindings = self.read_bindings(reader, 52, unit_count)
        self.level_bindings = self.read_bindings(reader, 60, level_count)

    def read_bindings(self, reader, header_offset, count):
        length, offset = reader.unpack("<2I", header_offset)
        reader.check(offset, length * 12)
        result = {}
        for index in range(length):
            identity, slot, _ = reader.unpack("<3I", offset + index * 12)
            if identity >= count or slot >= len(self.slots):
                raise ValueError(f"{reader.name}: invalid Flow object binding")
            result.setdefault(self.slots[slot], []).append(identity)
        return result
