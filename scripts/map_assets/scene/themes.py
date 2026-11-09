"""Level object sets that a mission's default theme hides.

A mission level loads with the themes its `<level>_mission_themes` Lua lists for the circumstance's theme tag; the
default circumstance uses the "default" tag. The engine spawns the level without the object sets those themes hide,
so their units do not exist in the default mission.
"""

from ..formats.binary import resource
from ..formats.level import key32
from ..formats.resource import murmur64

DEFAULT_THEME_TAG = "default"
THEME_SUFFIX = "_mission_themes"


def hidden_sets(path):
    """Object set names a compiled theme hides: its final length-prefixed, NUL-separated string block."""
    _, reader = resource(path, murmur64("theme"))
    data = reader.data
    for size in range(len(data) - 3):
        start = len(data) - size
        if reader.unpack("<I", start - 4)[0] == size and (size == 0 or data[-1] == 0):
            return [name.decode("utf-8") for name in data[start:].split(b"\0") if name]
    raise ValueError(f"{reader.name}: theme has no hidden object set block")


def hidden_set_keys(assets, theme_lists):
    """{level name: set of hidden object set hashes} from {level name: default theme resource names}."""
    paths = assets.extract("theme", {name for names in theme_lists.values() for name in names})
    return {level: {key32(name) for theme in names for name in hidden_sets(paths[murmur64(theme)])}
            for level, names in theme_lists.items()}
