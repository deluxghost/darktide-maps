"""Read literal game tables through the project's Lua syntax parser."""

import json
import os
import subprocess
from pathlib import Path

COMMAND_LINE_BUDGET = 30000   # Windows limits a command line to 32767 characters


def read_tables(mode, paths, context=None):
    """One parsed table per path; paths are split into batches that fit on one command line."""
    if context is not None:
        mode += ":" + json.dumps(context, separators=(",", ":"))
    converter = Path(__file__).with_suffix(".mjs")
    command = [os.environ["MAP_BUILD_NODE"], str(converter), mode]
    fixed = sum(len(part) + 3 for part in command)
    result, batch, size = [], [], fixed
    for path in map(str, paths):
        if batch and size + len(path) + 3 > COMMAND_LINE_BUDGET:
            result += convert(command + batch)
            batch, size = [], fixed
        batch.append(path)
        size += len(path) + 3
    if batch or not result:
        result += convert(command + batch)
    return result


def convert(command):
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        raise RuntimeError("Lua syntax conversion failed:\n"
                           + result.stderr.decode("utf-8", errors="backslashreplace"))
    return json.loads(result.stdout.decode("utf-8"))
