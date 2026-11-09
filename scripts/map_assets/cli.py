"""Build map web assets entirely from an installed Darktide game's static resources."""

import argparse
from pathlib import Path
import shutil

from .pipeline import build

INPUT_PATHS = ("game", "limn", "decompiler", "cache")
PATH_HELP = {
    "game": "Installed game directory (read-only input)",
    "limn": "limn executable for bundle extraction",
    "decompiler": "LuaJIT decompiler executable",
    "dictionary": "Optional resource-name dictionary for diagnostic labels; does not control extraction coverage",
    "cache": "Persistent extracted-resource cache directory",
    "work": "Build intermediates; must be new for a full build",
    "output": "Dedicated generated web-data directory (usually public/data)",
}


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "A full build requires --game, --limn, --decompiler and --cache. "
        "Rebuild web/reach/terrain needs only --work and --output. "
        "Game resource, scene construction or marker extraction changes require a new full build. "
        "Install Python dependencies from scripts/requirements.txt and run npm ci first."))
    for name in (*INPUT_PATHS, "dictionary", "work", "output"):
        parser.add_argument(f"--{name}", type=Path, required=name in ("work", "output"), help=PATH_HELP[name])
    parser.add_argument("--node", default="node", help="Node.js executable path or command")
    parser.add_argument("--workers", type=int, default=1, help="Parallel terrain map processes")
    parser.add_argument("--missions", nargs="+", help="Build only these fixed mission ids")
    parser.add_argument("--rebuild", choices=("terrain", "reach", "web"), help="Resume an internal stage from this build's work directory")
    args = parser.parse_args()
    node = shutil.which(args.node)
    if node is None:
        parser.error(f"Node.js executable not found: {args.node}")
    if args.workers < 1:
        parser.error("--workers must be positive")
    for name in (*INPUT_PATHS, "dictionary", "work", "output"):
        value = getattr(args, name)
        if value is None:
            if not args.rebuild and name in INPUT_PATHS:
                parser.error(f"--{name} is required for a new build")
            continue
        setattr(args, name, value.resolve())
    if args.output == args.work or args.output in args.work.parents or args.work in args.output.parents:
        parser.error("--work and --output must be separate, non-nested directories")
    if args.game and any(directory == args.game or args.game in directory.parents for directory in (args.work, args.output)):
        parser.error("Build directories must not be inside the read-only game installation")
    if args.rebuild and args.missions:
        parser.error("A stage rebuild preserves the work directory's mission set")
    args.node = str(Path(node).resolve())
    return args


def main():
    build(arguments())
