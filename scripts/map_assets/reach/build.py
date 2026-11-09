"""Build stage: player reachability of every mission, after terrain carving."""

import json
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np

from ..config import configuration
from ..terrain.world import CollisionAssets
from .display import displayed
from .regions import Reachability

NOT_EVALUATED = configuration("build")["reach"]["notEvaluatedMissions"]


def build_mission(mission, root):
    started = time.monotonic()
    path = root / "missions" / f"{mission}.json"
    packet = json.loads(path.read_text(encoding="utf-8"))
    if mission in NOT_EVALUATED:
        # no reachability layer: the reachable view shows all nav
        result = {"evaluated": False, "shownTriangles": list(range(len(packet["terrain"]["navmesh"]["triangles"]))),
                  "stats": {}}
    else:
        model = Reachability(packet, CollisionAssets(root, mission))
        reach = model.run()
        shown = displayed(model, reach)
        area = model.area
        # shownTriangles also includes unstandable slivers touching reachable floor.
        result = {"evaluated": True, "reachableTriangles": np.nonzero(reach)[0].tolist(),
                  "shownTriangles": np.nonzero(shown)[0].tolist(),
                  "stats": {**model.stats, "reachableArea": round(float(area[reach].sum()), 1),
                            "shownArea": round(float(area[shown].sum()), 1), "navArea": round(float(area.sum()), 1)}}
    result["stats"]["seconds"] = round(time.monotonic() - started, 1)
    packet["reach"] = result
    path.write_text(json.dumps(packet, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"mission": mission, **result["stats"]}


def build_reach(root, missions, workers):
    # largest missions first, so the longest ones do not start last; a fresh process per mission, so no worker
    # carries one mission's memory into the next
    order = sorted(missions, key=lambda mission: -(root / "missions" / f"{mission}.json").stat().st_size)
    with ProcessPoolExecutor(max_workers=workers, max_tasks_per_child=1) as pool:
        pending = [pool.submit(build_mission, mission, root) for mission in order]
        reports = {}
        for future in as_completed(pending):
            report = future.result()
            reports[report["mission"]] = report
            print(json.dumps(report), flush=True)
    return [reports[mission] for mission in missions]
