"""Resolve scalar and indexed component values against authored defaults."""

from ..formats.level import key32


def component_value(component, definitions, field):
    default = definitions[component["name"]][field]
    data = {tuple(path): value for path, value in component["data"]}
    key = key32(field)
    if not isinstance(default, (dict, list)):
        return data.get((key,), default)
    indexed = {path[1]: value for path, value in data.items() if len(path) == 2 and path[0] == key}
    if not indexed:
        return list(default)
    defaults = list(default)
    length = max(max(indexed) + 1, len(defaults))
    result = []
    for index in range(length):
        if index in indexed:
            result.append(indexed[index])
        elif index < len(defaults):
            result.append(defaults[index])
        else:
            raise ValueError(f"Sparse {component['name']}.{field} array at index {index}")
    return result
