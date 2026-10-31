import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {BufferGeometry, Float32BufferAttribute, Ray, Vector3, DoubleSide} from "three";
import {MeshBVH} from "three-mesh-bvh";

const root = process.argv[2];
if (!root) throw new Error("Missing internal map build directory");
const families = ["boss_spawns", "daemonhosts", "havoc_boss_spawns"];
const report = [];
const plan = JSON.parse(await readFile(path.join(root, "build.json"), "utf8"));
for (const mission of plan.missions) {
	const target = path.join(root, "missions", `${mission.id}.json`);
	const packet = JSON.parse(await readFile(target, "utf8"));
	const mesh = packet.navmesh;
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new Float32BufferAttribute(mesh.vertices.flat(), 3));
	geometry.setIndex(mesh.triangles.flatMap((triangle) => triangle.slice(0, 3).map((index) => index - 1)));
	const bvh = new MeshBVH(geometry, {indirect: true});
	for (const family of families) {
		const accepted = [], rejected = [];
		const clearance = family === "havoc_boss_spawns" ? 5 : 1;
		let vertical = 0, nearest = 0;
		for (const pin of packet.markers[family]) {
			if (pin.source.projection) throw new Error(`Marker projection already applied: ${target}`);
			const query = new Vector3(...pin.position);
			const ray = new Ray(query.clone().add(new Vector3(0, 0, clearance)), new Vector3(0, 0, -1));
			const hits = bvh.raycast(ray, DoubleSide, 0, clearance * 2)
				.sort((a, b) => Math.abs(a.point.z - query.z) - Math.abs(b.point.z - query.z));
			let projected = hits[0]?.point;
			let method = "vertical";
			if (!projected && family !== "havoc_boss_spawns") {
				const hit = bvh.closestPointToPoint(query, {}, 0, 5);
				if (hit && Math.abs(hit.point.z - query.z) <= clearance) projected = hit.point;
				method = "nearest_surface";
			}
			if (!projected) {
				rejected.push(pin);
				continue;
			}
			if (method === "vertical") vertical++; else nearest++;
			accepted.push({...pin, position: projected.toArray(),
				source: {...pin.source, authored_position: pin.position, projection: method}});
		}
		packet.markers[family] = accepted;
		report.push({mission: mission.id, family, vertical, nearest, rejected});
	}
	geometry.dispose();
	await writeFile(target, `${JSON.stringify(packet)}\n`);
}
await writeFile(path.join(root, "marker_projection.json"), `${JSON.stringify(report)}\n`);
console.log(`Projected monster candidate families: ${report.length}; rejected candidates: ${report.reduce((n, item) => n + item.rejected.length, 0)}`);
