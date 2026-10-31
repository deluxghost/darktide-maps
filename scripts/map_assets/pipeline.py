"""Run extraction, marker projection, terrain carving, web compilation, and publication."""

import json
import os
import shutil
import subprocess
import sys
import time

from .config import PACKAGE_ROOT
from .extract import extract
from .json_io import write_json
from .scene.main_path import route_triggers
from .terrain.build import build_terrain


def project_markers(args, plan):
    subprocess.run([args.node, str(PACKAGE_ROOT / "markers/project.mjs"), str(args.work)], check=True)
    for report in plan["missions"]:
        path = args.work / "missions" / f"{report['id']}.json"
        packet = json.loads(path.read_text(encoding="utf-8"))
        if packet["mainPath"]:
            for pin in packet["markers"]["havoc_boss_spawns"]:
                pin["trigger"] = {"positions": route_triggers(packet["mainPath"], pin["position"], plan["havocTriggerDistance"])}
        report["markers"] = {family: len(pins) for family, pins in packet["markers"].items()}
        write_json(path, packet)


def publish(source, output):
    allowed = {"maps", "maps.json", "game-text.json"}
    if output.is_symlink() or (output.exists() and set(path.name for path in output.iterdir()) - allowed):
        raise ValueError(f"Output is not a dedicated generated map-data directory: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_name(output.name + ".building")
    previous = output.with_name(output.name + ".previous")
    if staging.exists() or previous.exists():
        raise FileExistsError(f"Unfinished publication exists beside {output}")
    shutil.copytree(source, staging)
    replaced = False
    try:
        if output.exists():
            output.rename(previous)
            replaced = True
        staging.rename(output)
    except OSError:
        if replaced:
            previous.rename(output)
        if staging.exists():
            shutil.rmtree(staging)
        raise
    if replaced:
        shutil.rmtree(previous)


def build(args):
    os.environ["PYTHON"] = sys.executable
    os.environ["MAP_BUILD_NODE"] = args.node
    started = time.monotonic()
    stages = {}
    if args.rebuild:
        plan = json.loads((args.work / "build.json").read_text(encoding="utf-8"))
        if plan["format"] != "static-map-build-v2":
            raise ValueError("Work directory is not a current map build")
    else:
        plan = extract(args)
        stages["extract"] = time.monotonic() - started
        stage = time.monotonic()
        project_markers(args, plan)
        stages["markers"] = time.monotonic() - stage
    plan["complete"] = False
    plan["stageSeconds"] = stages
    write_json(args.work / "build.json", plan)
    if args.rebuild != "web":
        stage = time.monotonic()
        plan["terrain"] = build_terrain(args.work, [item["id"] for item in plan["missions"]], args.workers)
        stages["terrain"] = time.monotonic() - stage
    write_json(args.work / "build.json", plan)
    web = args.work / "web"
    stage = time.monotonic()
    subprocess.run([args.node, str(PACKAGE_ROOT / "web/index.mjs"), str(args.work), str(web)], check=True)
    stages["web"] = time.monotonic() - stage
    stage = time.monotonic()
    publish(web, args.output)
    stages["publish"] = time.monotonic() - stage
    plan["complete"] = True
    plan["buildSeconds"] = time.monotonic() - started
    write_json(args.work / "build.json", plan)
    print(f"Built {len(plan['missions'])} maps in {plan['buildSeconds']:.1f}s: {args.output}", flush=True)
    print(f"Stage seconds: {json.dumps(stages)}", flush=True)
