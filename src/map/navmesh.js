import { Geometry } from "@luma.gl/engine";
import {floorCoordinatesAttribute} from "./floorclip.js";

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

function markUnreachable(attributes, indices, reachableIndexCount) {
	const vertexCount = attributes.positions.value.length / 3;
	const reachable = new Uint8Array(vertexCount);
	for (let index = 0; index < reachableIndexCount; index++) reachable[indices[index]] = 1;
	const duplicates = new Map();
	for (let index = reachableIndexCount; index < indices.length; index++) {
		const vertex = indices[index];
		if (reachable[vertex] && !duplicates.has(vertex)) duplicates.set(vertex, vertexCount + duplicates.size);
	}
	// Shared boundary vertices need one copy so the flag stays constant within each triangle.
	if (duplicates.size) {
		attributes = Object.fromEntries(Object.entries(attributes).map(([name, {size, value}]) => {
			const expanded = new value.constructor((vertexCount + duplicates.size) * size);
			expanded.set(value);
			for (const [source, target] of duplicates) {
				expanded.set(value.subarray(source * size, (source + 1) * size), target * size);
			}
			return [name, {size, value: expanded}];
		}));
		indices = Uint32Array.from(indices);
	}
	for (let index = reachableIndexCount; index < indices.length; index++) {
		const vertex = duplicates.get(indices[index]) ?? indices[index];
		indices[index] = vertex;
		attributes.texCoords.value[vertex * 2 + 1] = 1;
	}
	return {attributes, indices};
}

export function createMesh(glb, colors, reachableIndexCount) {
	const indices = glb.indices;

	if (indices.length === 0) {
		return null;
	}

	const normals = new Float32Array(glb.positions.length);

	for (let index = 0; index < indices.length; index += 3) {
		const a = indices[index] * 3;
		const b = indices[index + 1] * 3;
		const c = indices[index + 2] * 3;

		addTriangleNormal(normals, glb.positions, a, b, c);
	}

	normalizeNormals(normals);

	const attributes = {
		positions: { size: 3, value: glb.positions },
		normals: { size: 3, value: normals },
		colors: { size: 3, value: colors },
		texCoords: floorCoordinatesAttribute(glb.floorIds),
	};
	return new Geometry({
		topology: "triangle-list",
		...(reachableIndexCount < indices.length
			? markUnreachable(attributes, indices, reachableIndexCount)
			: {attributes, indices}),
	});
}
