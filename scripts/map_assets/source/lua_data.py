"""Read literal game tables through the project's Lua syntax parser."""

import json
import os
import subprocess
from pathlib import Path


def read_tables(mode, paths, context=None):
    if context is not None:
        mode += ":" + json.dumps(context, separators=(",", ":"))
    converter = Path(__file__).with_suffix(".mjs")
    result = subprocess.run([os.environ["MAP_BUILD_NODE"], str(converter), mode, *(str(path) for path in paths)],
                            capture_output=True)
    if result.returncode:
        raise RuntimeError("Lua syntax conversion failed:\n"
                           + result.stderr.decode("utf-8", errors="backslashreplace"))
    return json.loads(result.stdout.decode("utf-8"))
