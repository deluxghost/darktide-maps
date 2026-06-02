const COORDINATE_PRECISION = 4;

function addEdge(edgeCounts, a, b) {
	if (a === b) {
		return;
	}

	const start = Math.min(a, b);
	const end = Math.max(a, b);
	const key = `${start}:${end}`;
	const edge = edgeCounts.get(key);

	if (edge) {
		edge.count++;
	} else {
		edgeCounts.set(key, { start, end, count: 1 });
	}
}

function canonicalVertices(positions) {
	const coordinateIds = new Map();
	const vertexIds = [];
	const representatives = [];

	for (let index = 0; index < positions.length; index += 3) {
		const key = [
			positions[index],
			positions[index + 1],
			positions[index + 2],
		].map((value) => value.toFixed(COORDINATE_PRECISION)).join(",");
		let coordinateId = coordinateIds.get(key);

		if (coordinateId === undefined) {
			coordinateId = coordinateIds.size;
			coordinateIds.set(key, coordinateId);
			representatives.push(index / 3);
		}

		vertexIds.push(coordinateId);
	}

	return { representatives, vertexIds };
}

function positionAt(positions, representatives, vertexId) {
	const index = representatives[vertexId] * 3;

	return [positions[index], positions[index + 1], positions[index + 2]];
}

function addAdjacentEdge(adjacency, vertexId, edgeId) {
	const edgeIds = adjacency.get(vertexId);

	if (edgeIds) {
		edgeIds.push(edgeId);
	} else {
		adjacency.set(vertexId, [edgeId]);
	}
}

function walkPath(edges, adjacency, visited, startVertexId, startEdgeId) {
	const vertexIds = [startVertexId];
	let vertexId = startVertexId;
	let edgeId = startEdgeId;

	while (edgeId !== undefined && !visited.has(edgeId)) {
		visited.add(edgeId);

		const edge = edges[edgeId];

		vertexId = edge.start === vertexId ? edge.end : edge.start;
		vertexIds.push(vertexId);

		const edgeIds = adjacency.get(vertexId);

		if (edgeIds.length !== 2) {
			break;
		}

		edgeId = edgeIds.find((candidate) => !visited.has(candidate));
	}

	return vertexIds;
}

function createPaths(edges) {
	const adjacency = new Map();
	const visited = new Set();
	const paths = [];

	for (let edgeId = 0; edgeId < edges.length; edgeId++) {
		const edge = edges[edgeId];

		addAdjacentEdge(adjacency, edge.start, edgeId);
		addAdjacentEdge(adjacency, edge.end, edgeId);
	}

	for (const [vertexId, edgeIds] of adjacency) {
		if (edgeIds.length === 2) {
			continue;
		}

		for (const edgeId of edgeIds) {
			if (!visited.has(edgeId)) {
				paths.push(walkPath(edges, adjacency, visited, vertexId, edgeId));
			}
		}
	}

	for (let edgeId = 0; edgeId < edges.length; edgeId++) {
		if (!visited.has(edgeId)) {
			paths.push(walkPath(edges, adjacency, visited, edges[edgeId].start, edgeId));
		}
	}

	return paths;
}

export function createBoundaryPaths(glb) {
	const edgeCounts = new Map();
	const { representatives, vertexIds } = canonicalVertices(glb.positions);

	for (let index = 0; index < glb.indices.length; index += 3) {
		const a = vertexIds[glb.indices[index]];
		const b = vertexIds[glb.indices[index + 1]];
		const c = vertexIds[glb.indices[index + 2]];

		addEdge(edgeCounts, a, b);
		addEdge(edgeCounts, b, c);
		addEdge(edgeCounts, c, a);
	}

	const edges = Array.from(edgeCounts.values()).filter((edge) => edge.count === 1);

	return createPaths(edges).map((vertexPath) => ({
		path: vertexPath.map((vertexId) => positionAt(glb.positions, representatives, vertexId)),
	}));
}
