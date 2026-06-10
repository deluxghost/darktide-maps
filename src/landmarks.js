import { Geometry } from "@luma.gl/engine";

function positionKey(positions, index) {
	const offset = index * 3;

	return [
		positions[offset].toFixed(4),
		positions[offset + 1].toFixed(4),
		positions[offset + 2].toFixed(4),
	].join(",");
}

function edgeKey(positions, a, b) {
	const left = positionKey(positions, a);
	const right = positionKey(positions, b);

	return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function positionAt(positions, index) {
	const offset = index * 3;

	return [
		positions[offset],
		positions[offset + 1],
		positions[offset + 2],
	];
}

export function createGeometryBoundaryPaths(glb) {
	const edges = new Map();

	for (let index = 0; index < glb.indices.length; index += 3) {
		for (const [a, b] of [
			[glb.indices[index], glb.indices[index + 1]],
			[glb.indices[index + 1], glb.indices[index + 2]],
			[glb.indices[index + 2], glb.indices[index]],
		]) {
			const key = edgeKey(glb.positions, a, b);
			const edge = edges.get(key);

			if (edge) {
				edge.count++;
			} else {
				edges.set(key, {
					count: 1,
					path: [positionAt(glb.positions, a), positionAt(glb.positions, b)],
				});
			}
		}
	}

	return [...edges.values()]
		.filter((edge) => edge.count === 1)
		.map((edge) => ({path: edge.path}));
}

export function createPathBoundaryPaths(glb) {
	const pathLengths = glb.extras?.pathLengths;

	if (!Array.isArray(pathLengths)) {
		throw new Error("Boundary GLB is missing path lengths.");
	}

	const paths = [];
	let vertexOffset = 0;

	for (const pathLength of pathLengths) {
		if (!Number.isInteger(pathLength) || pathLength < 2) {
			throw new Error(`Boundary GLB has an invalid path length: ${pathLength}.`);
		}

		const path = [];

		for (let index = 0; index < pathLength; index++) {
			const positionOffset = (vertexOffset + index) * 3;

			path.push([
				glb.positions[positionOffset],
				glb.positions[positionOffset + 1],
				glb.positions[positionOffset + 2],
			]);
		}

		paths.push({path});
		vertexOffset += pathLength;
	}

	if (vertexOffset !== glb.positions.length / 3) {
		throw new Error("Boundary GLB path lengths do not match its positions.");
	}

	return paths;
}

export function createLandmarkMesh(glb) {
	if (!glb.normals) {
		throw new Error("Landmark GLB is missing normals.");
	}

	return new Geometry({
		topology: "triangle-list",
		attributes: {
			positions: { size: 3, value: glb.positions },
			normals: { size: 3, value: glb.normals },
		},
		indices: glb.indices,
	});
}
