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

function validateMesh(mesh, count, uniform, name) {
	assert.equal(mesh.floorIds?.length, mesh.positions.length / 3, name + ": layer attribute");
	for (const value of mesh.positions) assert.ok(Number.isFinite(value), name + ": vertex coordinate");
	for (const value of mesh.floorIds) assert.ok(Number.isFinite(value) && value >= 0 && value < count, name + ": layer range");
	for (const index of mesh.indices) assert.ok(index < mesh.floorIds.length, name + ": vertex index");
	if (!uniform) return;
	for (let index = 0; index < mesh.indices.length; index += 3) {
		const values = Array.from(mesh.indices.slice(index, index + 3), (vertex) => mesh.floorIds[vertex]);
		assert.equal(values[0], values[1], name + ": mixed triangle ownership");
		assert.equal(values[0], values[2], name + ": mixed triangle ownership");
		assert.equal(values[0] % 1, 0.5, name + ": nonintegral layer");
	}
}

export function validateAssets(root) {
	const manifest = readJson(path.join(root, "maps.json"));
	for (const entry of manifest.maps) {
		const directory = path.join(root, "maps", entry.id);
		const map = readJson(path.join(directory, "map.json"));
		const count = map.floorSlices.layers.length;
		assert.ok(count > 0, entry.id + ": missing layers");
		for (const layer of map.floorSlices.layers) {
			assert.ok(Number.isFinite(layer.minZ) && Number.isFinite(layer.maxZ) && layer.minZ <= layer.maxZ);
		}
		const navmesh = readGlb(path.join(directory, "navmesh.glb"));
		validateMesh(navmesh, count, true, entry.id + "/navmesh");
		assert.equal(new Set(Array.from(navmesh.floorIds, Math.floor)).size, count, entry.id + ": empty layer");
		const boundary = readGlb(path.join(directory, "navmesh_boundaries.glb"));
		assert.equal(boundary.extras.pathLengths.length, boundary.extras.floorIndices.length);
		assert.equal(boundary.extras.pathLengths.reduce((sum, length) => sum + length, 0), boundary.positions.length / 3);
		for (const floor of boundary.extras.floorIndices) assert.ok(Number.isInteger(floor) && floor >= 0 && floor < count);
		for (const marker of map.markers?.pins ?? []) {
			assert.ok(Number.isInteger(marker.floorIndex) && marker.floorIndex >= 0 && marker.floorIndex < count);
		}
		for (const asset of [map.diagnostics.terrainClip, map.landmarks?.mainPath].filter(Boolean)) {
			const glb = readGlb(path.join(directory, path.basename(asset.file)));
			if (asset === map.diagnostics.terrainClip) assert.deepEqual(Object.keys(glb.parts), ["removed"]);
			for (const [part, mesh] of Object.entries(glb.parts)) validateMesh(mesh, count, part !== "connectors", entry.id + "/" + part);
		}
	}
	console.log(`Validated geometry and layer ownership for ${manifest.maps.length} maps`);
}
