"""Read the repository's shared build and marker policies."""

import json
from functools import cache
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent.parent
CONFIG_ROOT = PROJECT_ROOT / "config"


@cache
def configuration(name):
    return json.loads((CONFIG_ROOT / (name + ".json")).read_text(encoding="utf-8"))
