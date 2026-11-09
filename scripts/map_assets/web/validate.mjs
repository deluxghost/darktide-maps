import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {parseGlb} from "../../../src/data/glb.js";

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readGlb(file) {
	const bytes = fs.readFileSync(file);
	return parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function validateMesh(mesh, counts, uniform, name) {
	for (const value of mesh.positions) assert.ok(Number.isFinite(value), name + ": vertex coordinate");
	for (const [field, count] of [["floorIds", counts.all], ["reachFloorIds", counts.reach]]) {
		const floors = mesh[field];
		assert.equal(floors?.length, mesh.positions.length / 3, `${name}: ${field} attribute`);
		for (const value of floors) assert.ok(Number.isFinite(value) && value >= 0 && value < count, `${name}: ${field} range`);
		if (!uniform) continue;
		for (let index = 0; index < mesh.indices.length; index += 3) {
			const values = Array.from(mesh.indices.slice(index, index + 3), (vertex) => floors[vertex]);
			assert.equal(values[0], values[1], `${name}: mixed ${field} ownership`);
			assert.equal(values[0], values[2], `${name}: mixed ${field} ownership`);
			assert.equal(values[0] % 1, 0.5, `${name}: nonintegral ${field}`);
		}
	}
	for (const index of mesh.indices) assert.ok(index < mesh.positions.length / 3, name + ": vertex index");
}

function usedFloors(mesh, floors, first, last) {
	return new Set(Array.from(mesh.indices.slice(first * 3, last * 3), (vertex) => Math.floor(floors[vertex])));
}

export async function validateAssets(root) {
	const manifest = readJson(path.join(root, "maps.json"));
	for (const entry of manifest.maps) {
		const directory = path.join(root, "maps", entry.id);
		const map = readJson(path.join(directory, "map.json"));
		const counts = {all: map.floorSlices.layers.length, reach: map.floorSlices.reachLayers.length};
		assert.ok(counts.all > 0 && counts.reach > 0, entry.id + ": missing layers");
		for (const layer of [...map.floorSlices.layers, ...map.floorSlices.reachLayers]) {
			assert.ok(Number.isFinite(layer.minZ) && Number.isFinite(layer.maxZ) && layer.minZ <= layer.maxZ);
		}
		const navmesh = await readGlb(path.join(directory, "navmesh.glb"));
		validateMesh(navmesh, counts, true, entry.id + "/navmesh");
		const total = navmesh.indices.length / 3, shown = map.reach.shownTriangles;
		assert.ok(Number.isInteger(shown) && shown > 0 && shown <= total && (map.reach.evaluated || shown === total), entry.id + ": reachable view");
		assert.equal(usedFloors(navmesh, navmesh.floorIds, 0, total).size, counts.all, entry.id + ": empty layer");
		assert.equal(usedFloors(navmesh, navmesh.reachFloorIds, 0, shown).size, counts.reach, entry.id + ": empty reachable layer");
		const boundary = await readGlb(path.join(directory, "navmesh_boundaries.glb"));
		const groups = boundary.extras.stats.groups;
		assert.equal(boundary.extras.pathLengths.length, boundary.extras.floorIndices.length);
		assert.equal(groups.all + groups.reach, boundary.extras.floorIndices.length);
		assert.equal(boundary.extras.pathLengths.reduce((sum, length) => sum + length, 0), boundary.positions.length / 3);
		boundary.extras.floorIndices.forEach((floor, index) => {
			assert.ok(Number.isInteger(floor) && floor >= 0 && floor < (index < groups.all ? counts.all : counts.reach));
		});
		for (const marker of map.markers?.pins ?? []) {
			assert.ok(Number.isInteger(marker.floorIndex) && marker.floorIndex >= 0 && marker.floorIndex < counts.all);
			assert.ok(Number.isInteger(marker.reachFloorIndex) && marker.reachFloorIndex >= 0 && marker.reachFloorIndex < counts.reach);
		}
		for (const asset of [map.diagnostics.terrainClip, map.landmarks?.mainPath].filter(Boolean)) {
			const glb = await readGlb(path.join(directory, path.basename(asset.file)));
			if (asset === map.diagnostics.terrainClip) assert.deepEqual(Object.keys(glb.parts), ["removed"]);
			for (const [part, mesh] of Object.entries(glb.parts)) validateMesh(mesh, counts, part !== "connectors", entry.id + "/" + part);
		}
	}
	console.log(`Validated geometry and layer ownership for ${manifest.maps.length} maps`);
}
