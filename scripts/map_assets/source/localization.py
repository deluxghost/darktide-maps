"""Read localized text from the installed UI string resource."""

from ..formats.binary import resource_variants
from ..formats.resource import murmur64

LANGUAGES = {0: "en", 1: "pl", 2: "ja", 4: "es", 16: "zh-tw", 32: "pt-br",
             64: "de", 128: "ko", 256: "ru", 512: "it", 1024: "zh-cn", 2048: "fr"}


def read_strings(path, keys):
    _, variants = resource_variants(path, murmur64("strings"))
    wanted = {murmur64(key) >> 32: key for key in keys}
    if len(wanted) != len(set(keys)):
        raise ValueError("Localization key hash collision")
    titles = {key: {} for key in keys}
    for language, reader in variants:
        if language == 8:
            continue
        if language not in LANGUAGES:
            raise ValueError(f"Unknown localization language variant {language}")
        count, = reader.unpack("<I", 0)
        entries = [reader.unpack("<2I", 4 + index * 8) for index in range(count)]
        for index, (identity, start) in enumerate(entries):
            if identity not in wanted:
                continue
            end = entries[index + 1][1] if index + 1 < count else len(reader.data)
            if start < 4 + count * 8:
                raise ValueError(f"{path}: localization text overlaps index table")
            reader.check(start, end - start)
            terminator = reader.data.index(0, start, end)
            titles[wanted[identity]][LANGUAGES[language]] = reader.data[start:terminator].decode("utf-8")
    missing = [key for key, values in titles.items() if not values.get("en")]
    if missing:
        raise ValueError(f"Missing English localized text: {missing}")
    return titles
