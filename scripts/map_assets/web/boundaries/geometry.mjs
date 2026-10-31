import {BUILD_CONFIG} from "../config.mjs";

const COORDINATE_PRECISION = BUILD_CONFIG.boundaries.coordinatePrecision;
const LINE_GROUP_PRECISION = Math.max(0, COORDINATE_PRECISION - 2);
const REPAIRED_VERTEX_PRECISION = Math.max(0, COORDINATE_PRECISION - 1);
const REFERENCE_EDGE_TOLERANCE = 2 * 10 ** -LINE_GROUP_PRECISION;
export const EPSILON = 1e-6;

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
		edgeCounts.set(key, {start, end, count: 1});
	}
}

function quantized(value) {
	return value.toFixed(COORDINATE_PRECISION);
}

function lineGroupQuantized(value) {
	return value.toFixed(LINE_GROUP_PRECISION);
}

export function navmeshGeometry(navmesh) {
	const positions = new Float32Array(navmesh.vertices.length * 3);
	const indices = new Uint32Array(navmesh.triangles.length * 3);

	for (let index = 0; index < navmesh.vertices.length; index++) {
		positions.set(navmesh.vertices[index], index * 3);
	}

	for (let index = 0; index < navmesh.triangles.length; index++) {
		const triangle = navmesh.triangles[index];

		indices.set(triangle.slice(0, 3).map((vertexIndex) => vertexIndex - 1), index * 3);
	}

	return {positions, indices};
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
		].map(quantized).join(",");
		let coordinateId = coordinateIds.get(key);

		if (coordinateId === undefined) {
			coordinateId = coordinateIds.size;
			coordinateIds.set(key, coordinateId);
			representatives.push(index / 3);
		}

		vertexIds.push(coordinateId);
	}

	return {representatives, vertexIds};
}

function positionAt(positions, representatives, vertexId) {
	const index = representatives[vertexId] * 3;

	return [positions[index], positions[index + 1], positions[index + 2]];
}

export function lineGroupKey(start, end) {
	const dx = end[0] - start[0];
	const dy = end[1] - start[1];
	const length = Math.hypot(dx, dy);

	if (length <= EPSILON) {
		return null;
	}

	let direction = [dx / length, dy / length];

	if (direction[0] < -EPSILON || (Math.abs(direction[0]) <= EPSILON && direction[1] < 0)) {
		direction = [-direction[0], -direction[1]];
	}

	const normal = [-direction[1], direction[0]];
	const lineOffset = normal[0] * start[0] + normal[1] * start[1];
	const startT = direction[0] * start[0] + direction[1] * start[1];
	const endT = direction[0] * end[0] + direction[1] * end[1];
	const zSlope = (end[2] - start[2]) / (endT - startT);
	const zOffset = start[2] - zSlope * startT;

	return [
		lineGroupQuantized(normal[0]),
		lineGroupQuantized(normal[1]),
		lineGroupQuantized(lineOffset),
		lineGroupQuantized(zSlope),
		lineGroupQuantized(zOffset),
	].join(",");
}

function createLineGroup(start, end) {
	const dx = end[0] - start[0];
	const dy = end[1] - start[1];
	const length = Math.hypot(dx, dy);
	let direction = [dx / length, dy / length];

	if (direction[0] < -EPSILON || (Math.abs(direction[0]) <= EPSILON && direction[1] < 0)) {
		direction = [-direction[0], -direction[1]];
	}

	const normal = [-direction[1], direction[0]];
	const lineOffset = normal[0] * start[0] + normal[1] * start[1];

	return {
		direction,
		normal,
		lineOffset,
		segments: [],
	};
}

function pointOnGroupLine(group, t) {
	const x = group.normal[0] * group.lineOffset + group.direction[0] * t;
	const y = group.normal[1] * group.lineOffset + group.direction[1] * t;

	return [x, y];
}

function addLineSegment(groups, start, end) {
	const key = lineGroupKey(start, end);

	if (!key) {
		return;
	}

	const group = groups.get(key) ?? createLineGroup(start, end);
	const startT = group.direction[0] * start[0] + group.direction[1] * start[1];
	const endT = group.direction[0] * end[0] + group.direction[1] * end[1];

	group.segments.push({
		minT: Math.min(startT, endT),
		maxT: Math.max(startT, endT),
		zSlope: (end[2] - start[2]) / (endT - startT),
		zOffset: start[2] - ((end[2] - start[2]) / (endT - startT)) * startT,
	});
	groups.set(key, group);
}

function uniqueSorted(values) {
	const result = [];

	for (const value of [...values].sort((left, right) => left - right)) {
		const previous = result[result.length - 1];

		if (previous === undefined || Math.abs(value - previous) > EPSILON) {
			result.push(value);
		}
	}

	return result;
}

function coveringSegments(segments, start, end) {
	const middle = (start + end) / 2;

	return segments.filter((segment) => (
		middle >= segment.minT - EPSILON
		&& middle <= segment.maxT + EPSILON
	));
}

function pointOnSegmentLine(group, segment, t) {
	const [x, y] = pointOnGroupLine(group, t);

	return [x, y, segment.zSlope * t + segment.zOffset];
}

function addRepairedEdge(edges, vertices, vertexIds, start, end) {
	const ids = [start, end].map((point) => {
		const key = point.map((value) => value.toFixed(REPAIRED_VERTEX_PRECISION)).join(",");
		let id = vertexIds.get(key);

		if (id === undefined) {
			id = vertices.length;
			vertexIds.set(key, id);
			vertices.push(point);
		}

		return id;
	});

	if (ids[0] !== ids[1]) {
		edges.push({start: ids[0], end: ids[1]});
	}
}

function repairedEdgeKey(edge) {
	const start = Math.min(edge.start, edge.end);
	const end = Math.max(edge.start, edge.end);

	return `${start}:${end}`;
}

function uniqueBoundaryEdges(edges) {
	const counts = new Map();

	for (const edge of edges) {
		const key = repairedEdgeKey(edge);
		const entry = counts.get(key);

		if (entry) {
			entry.count++;
		} else {
			counts.set(key, {edge, count: 1});
		}
	}

	return [...counts.values()]
		.filter((entry) => entry.count % 2 === 1)
		.map((entry) => entry.edge);
}

function repairedBoundaryEdges(candidateEdges, representatives, positions) {
	const groups = new Map();
	const edges = [];
	const vertices = [];
	const vertexIds = new Map();

	for (const edge of candidateEdges) {
		addLineSegment(
			groups,
			positionAt(positions, representatives, edge.start),
			positionAt(positions, representatives, edge.end),
		);
	}

	for (const group of groups.values()) {
		const cuts = uniqueSorted(group.segments.flatMap((segment) => [segment.minT, segment.maxT]));

		for (let index = 0; index < cuts.length - 1; index++) {
			const start = cuts[index];
			const end = cuts[index + 1];
			const covering = coveringSegments(group.segments, start, end);

			if (end - start <= EPSILON || covering.length % 2 === 0) {
				continue;
			}

			addRepairedEdge(
				edges,
				vertices,
				vertexIds,
				pointOnSegmentLine(group, covering[0], start),
				pointOnSegmentLine(group, covering[0], end),
			);
		}
	}

	return {
		edges: uniqueBoundaryEdges(edges),
		vertices,
	};
}

export function navmeshInternalEdgeGroups(navmesh) {
	const {positions, indices} = navmeshGeometry(navmesh);
	const edgeCounts = new Map();
	const groups = new Map();

	for (let index = 0; index < indices.length; index += 3) {
		addEdge(edgeCounts, indices[index], indices[index + 1]);
		addEdge(edgeCounts, indices[index + 1], indices[index + 2]);
		addEdge(edgeCounts, indices[index + 2], indices[index]);
	}

	for (const edge of edgeCounts.values()) {
		if (edge.count < 2) {
			continue;
		}

		const start = [
			positions[edge.start * 3],
			positions[edge.start * 3 + 1],
			positions[edge.start * 3 + 2],
		];
		const end = [
			positions[edge.end * 3],
			positions[edge.end * 3 + 1],
			positions[edge.end * 3 + 2],
		];
		const key = lineGroupKey(start, end);

		if (!key) {
			continue;
		}

		const list = groups.get(key) ?? [];

		list.push([start, end]);
		groups.set(key, list);
	}

	return groups;
}

function pointToSegmentDistance3d(point, start, end) {
	const segment = [
		end[0] - start[0],
		end[1] - start[1],
		end[2] - start[2],
	];
	const relative = [
		point[0] - start[0],
		point[1] - start[1],
		point[2] - start[2],
	];
	const lengthSquared = segment[0] ** 2 + segment[1] ** 2 + segment[2] ** 2;
	const amount = lengthSquared
		? Math.max(0, Math.min(1, (
			relative[0] * segment[0]
			+ relative[1] * segment[1]
			+ relative[2] * segment[2]
		) / lengthSquared))
		: 0;

	return Math.hypot(
		point[0] - (start[0] + segment[0] * amount),
		point[1] - (start[1] + segment[1] * amount),
		point[2] - (start[2] + segment[2] * amount),
	);
}

export function segmentLiesOnReferenceInternalEdge(start, end, referenceEdges) {
	const key = lineGroupKey(start, end);

	if (!key) {
		return false;
	}

	return (referenceEdges.get(key) ?? []).some(([referenceStart, referenceEnd]) => (
		pointToSegmentDistance3d(start, referenceStart, referenceEnd) <= REFERENCE_EDGE_TOLERANCE
		&& pointToSegmentDistance3d(end, referenceStart, referenceEnd) <= REFERENCE_EDGE_TOLERANCE
	));
}

export function boundaryGraph(positions, indices) {
	const edgeCounts = new Map();
	const {representatives, vertexIds} = canonicalVertices(positions);

	for (let index = 0; index < indices.length; index += 3) {
		const a = vertexIds[indices[index]];
		const b = vertexIds[indices[index + 1]];
		const c = vertexIds[indices[index + 2]];

		addEdge(edgeCounts, a, b);
		addEdge(edgeCounts, b, c);
		addEdge(edgeCounts, c, a);
	}

	return repairedBoundaryEdges(
		Array.from(edgeCounts.values()).filter((edge) => edge.count % 2 === 1),
		representatives,
		positions,
	);
}
