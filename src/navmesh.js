import { Geometry } from "@luma.gl/engine";
import { APP_CONFIG } from "./config.js";

const HEIGHT_COLORS = APP_CONFIG.runtime.visual.navmesh.heightColors;

function addTriangleNormal(normals, positions, a, b, c) {
	const abX = positions[b] - positions[a];
	const abY = positions[b + 1] - positions[a + 1];
	const abZ = positions[b + 2] - positions[a + 2];
	const acX = positions[c] - positions[a];
	const acY = positions[c + 1] - positions[a + 1];
	const acZ = positions[c + 2] - positions[a + 2];
	const x = abY * acZ - abZ * acY;
	const y = abZ * acX - abX * acZ;
	const z = abX * acY - abY * acX;

	for (const vertex of [a, b, c]) {
		normals[vertex] += x;
		normals[vertex + 1] += y;
		normals[vertex + 2] += z;
	}
}

function normalizeNormals(normals) {
	for (let index = 0; index < normals.length; index += 3) {
		const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;

		normals[index] /= length;
		normals[index + 1] /= length;
		normals[index + 2] /= length;
	}
}

function interpolateHeightColor(ratio) {
	const scaled = Math.min(Math.max(ratio, 0), 1) * (HEIGHT_COLORS.length - 1);
	const index = Math.min(Math.floor(scaled), HEIGHT_COLORS.length - 2);
	const amount = scaled - index;
	const start = HEIGHT_COLORS[index];
	const end = HEIGHT_COLORS[index + 1];

	return [
		start[0] + (end[0] - start[0]) * amount,
		start[1] + (end[1] - start[1]) * amount,
		start[2] + (end[2] - start[2]) * amount,
	];
}

function sortedHeights(positions) {
	const heights = [];

	for (let index = 2; index < positions.length; index += 3) {
		heights.push(positions[index]);
	}

	return heights.sort((a, b) => a - b);
}

function heightPercentile(height, heights) {
	let low = 0;
	let high = heights.length;

	while (low < high) {
		const middle = (low + high) >> 1;

		if (heights[middle] <= height) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	return heights.length > 1 ? (low - 1) / (heights.length - 1) : 0;
}

export function createMesh(glb) {
	const normals = new Float32Array(glb.positions.length);
	const colors = new Float32Array(glb.positions.length);
	const heights = sortedHeights(glb.positions);

	for (let index = 0; index < glb.indices.length; index += 3) {
		const a = glb.indices[index] * 3;
		const b = glb.indices[index + 1] * 3;
		const c = glb.indices[index + 2] * 3;

		addTriangleNormal(normals, glb.positions, a, b, c);
	}

	normalizeNormals(normals);

	for (let index = 0; index < glb.positions.length; index += 3) {
		const color = interpolateHeightColor(heightPercentile(glb.positions[index + 2], heights));

		colors[index] = color[0] / 255;
		colors[index + 1] = color[1] / 255;
		colors[index + 2] = color[2] / 255;
	}

	return new Geometry({
		topology: "triangle-list",
		attributes: {
			positions: { size: 3, value: glb.positions },
			normals: { size: 3, value: normals },
			colors: { size: 3, value: colors },
		},
		indices: glb.indices,
	});
}
