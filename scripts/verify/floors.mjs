import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {parseGlb} from "../../src/glb.js";
import {createFloorSampler} from "../preprocess/floors/sampler.mjs";
import {FLOOR_CASES} from "./floor_cases.mjs";

const root = path.resolve(process.argv[2] ?? "public/data");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function readGlb(file) {
	const bytes = fs.readFileSync(file);
	return parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function verifyMesh(mesh, count, uniform, name) {
	assert.equal(mesh.floorIds?.length, mesh.positions.length / 3, name + ": floor attribute");
	for (const value of mesh.floorIds) assert.ok(Number.isFinite(value) && value >= 0 && value < count, name + ": floor range");
	for (const index of mesh.indices) assert.ok(index < mesh.floorIds.length, name + ": vertex index");
	if (!uniform) return;
	for (let index = 0; index < mesh.indices.length; index += 3) {
		const values = Array.from(mesh.indices.slice(index, index + 3), (vertex) => mesh.floorIds[vertex]);
		assert.equal(values[0], values[1], name + ": mixed triangle ownership");
		assert.equal(values[0], values[2], name + ": mixed triangle ownership");
		assert.equal(values[0] % 1, 0.5, name + ": nonintegral floor");
	}
}

const manifest = readJson(path.join(root, "maps.json"));
const maps = new Map();
const report = [];
for (const entry of manifest.maps) {
	const directory = path.join(root, "maps", entry.id);
	const map = readJson(path.join(directory, "map.json"));
	const count = map.floorSlices.layers.length;
	assert.equal(map.floorSlices.algorithm, "ordered-cut-v3");
	assert.ok(count > 0);
	assert.ok(!map.floorSlices.clipGrid, "Obsolete floor grid must not be shipped");
	assert.equal(map.floorSlices.stats.displayAreas.length, count);
	assert.ok(map.floorSlices.stats.displayAreas.every(area => Number.isFinite(area) && area > 0));
	const navmesh = readGlb(path.join(directory, "navmesh.glb"));
	verifyMesh(navmesh, count, true, entry.id + "/navmesh");
	assert.equal(navmesh.indices.length / 3, map.floorSlices.stats.outputTriangles);
	assert.ok(map.floorSlices.stats.maxTriangleAreaError < 1e-7);
	const boundary = readGlb(path.join(directory, "navmesh_boundaries.glb"));
	assert.equal(boundary.extras.pathLengths.length, boundary.extras.floorIndices.length);
	assert.equal(boundary.extras.pathLengths.reduce((sum, length) => sum + length, 0), boundary.positions.length / 3);
	for (const floor of boundary.extras.floorIndices) assert.ok(Number.isInteger(floor) && floor >= 0 && floor < count);
	for (const marker of map.markers?.pins ?? []) assert.ok(Number.isInteger(marker.floorIndex) && marker.floorIndex >= 0 && marker.floorIndex < count);
	for (const file of ["main_path.glb", "blocked_edges.glb"]) {
		if (!fs.existsSync(path.join(directory, file))) continue;
		const glb = readGlb(path.join(directory, file));
		for (const [part, mesh] of Object.entries(glb.parts)) verifyMesh(mesh, count, part !== "connectors", entry.id + "/" + part);
	}
	maps.set(entry.id, {navmesh, count});
	report.push({id: entry.id, floors: count, triangles: navmesh.indices.length / 3, preprocessMs: map.floorSlices.stats.totalMs});
}

// Historical samples are diagnostics, not absolute-height constraints on the new topology.
const historical = [];
for (const [kind, cases] of Object.entries(FLOOR_CASES)) {
	for (const item of cases) {
		const data = maps.get(item.mapId);
		if (!data) continue;
		data.sampler ??= createFloorSampler({...data.navmesh, labels: Array.from(data.navmesh.floorIds, (value) => Math.floor(value))});
		const groups = item.pairs ?? [item.points];
		for (const points of groups) {
			const floors = points.map((point) => data.sampler.floorAt(point));
			historical.push({name: item.name, kind, floors, same: new Set(floors).size === 1});
		}
	}
}
console.log(JSON.stringify({verifiedMaps: report.length, maps: report, historical}, null, 2));
