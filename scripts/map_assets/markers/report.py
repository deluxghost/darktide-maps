"""Write a readable spatial-semantics summary from the build's marker diagnostics."""

from collections import Counter


def label(value):
    return value.get("zh-cn", value["en"]) if isinstance(value, dict) else value


def write_marker_report(plan, titles, output):
    lines = ["# 任务点与地点的空间含义", "",
             "地点标记使用触发区域的关卡锚点，不是精确的单点触发位置。",
             "多点任务保留各个已配置目标，不把分散目标平均成一个虚构位置。",
             "当前静态关联未定位到空间锚点的任务不会生成虚构坐标。", ""]
    for mission in plan["missions"]:
        notes = mission["marker_semantics"]
        lines.extend([f"## {label(titles[mission['id']])} (`{mission['id']}`)", ""])
        locations = Counter(label(entry["name"]) for entry in notes["locations"])
        lines.append("地点区域：" + ("；".join(f"{name}（{count} 个区域）" for name, count in locations.items()) or "无") + "。")
        lines.extend(["", "任务空间例外："])
        exceptions = []
        for entry in notes["objectives"]:
            if entry["spatial_kind"] == "undefined_objective":
                exceptions.append(f"- `{entry['objective']}`：当前游戏没有任务定义，不生成名称或点位。")
                continue
            count = len(entry["points"])
            regions = entry["region_anchors"]
            if count == 0:
                exceptions.append(f"- {label(entry['name'])}：当前静态关联未定位到独立空间锚点。")
            elif count > 1 or regions:
                suffix = f"，其中 {regions} 个为区域锚点" if regions else ""
                exceptions.append(f"- {label(entry['name'])}：{count} 个目标锚点{suffix}。")
        lines.extend(exceptions or ["- 无。"])
        lines.append("")
    output.write_text("\n".join(lines), encoding="utf-8")
