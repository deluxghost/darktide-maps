"""Read the installed game's compiled global physics templates and filter masks."""

from enum import IntFlag

from .binary import resource
from .resource import murmur64
from .unit_geometry import Cursor

PHYSICS_VERSION = 14
ACTOR_TEMPLATE_FLAGS_INDEX = 0


class ActorTemplateFlag(IntFlag):
    DYNAMIC = 1 << 0
    KINEMATIC = 1 << 1    # moved only by code (animation, Flow), never by the simulation; in game Actor.is_kinematic


class ShapeTemplateFlag(IntFlag):
    DISABLE_COLLISION = 1 << 0
    TRIGGER = 1 << 5


def read_physics(path):
    name, reader = resource(path, murmur64("physics_properties"))
    cursor = Cursor(reader)
    if name != murmur64("application_settings/global") or cursor.count() != PHYSICS_VERSION:
        raise ValueError(f"{path}: unsupported global physics resource")
    materials = {}
    for _ in range(cursor.count()):
        name, *values = cursor.read("<I4f2I")
        materials[name] = values
    shapes = {}
    for _ in range(cursor.count()):
        name, flags, membership, mask = cursor.read("<IIQQ")
        shapes[name] = {"flags": flags, "is": membership, "collides_with": mask}
    actors = {}
    for _ in range(cursor.count()):
        name, *words = cursor.read("<10I")
        actors[name] = words
    filters = {}
    for _ in range(cursor.count()):
        name, membership, mask = cursor.read("<IQQ")
        filters[name] = {"is": membership, "collides_with": mask}
    if cursor.read("<3I") != (0, 0, 0) or cursor.offset != len(reader.data):
        raise ValueError(f"{path}: unsupported additional physics tables")
    query = filters[murmur64("filter_player_mover") >> 32]
    for shape in shapes.values():
        shape["matches_player_mover_filter"] = bool(shape["is"] & query["collides_with"] or query["is"] & shape["collides_with"])
    for table in (shapes, filters):
        for profile in table.values():
            for field in ("is", "collides_with"):
                profile[field] = f"0x{profile[field]:016x}"
    return {"materials": materials, "shapes": shapes, "actors": actors, "filters": filters}
