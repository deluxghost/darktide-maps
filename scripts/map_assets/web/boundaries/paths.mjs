import {BUILD_CONFIG} from "../config.mjs";
import {EPSILON, segmentLiesOnReferenceInternalEdge} from "./geometry.mjs";

const MINIMUM_COLLAPSED_AREA = BUILD_CONFIG.boundaries.minimumCollapsedArea;
const MAXIMUM_DANGLING_BRANCH_LENGTH = BUILD_CONFIG.boundaries.maximumDanglingBranchLength;

if (!Number.isFinite(MAXIMUM_DANGLING_BRANCH_LENGTH)) {
	throw new Error("Missing boundary config: maximumDanglingBranchLength");
}

function addAdjacentEdge(adjacency, vertexId, edgeId) {
	const edgeIds = adjacency.get(vertexId);

	if (edgeIds) {
		edgeIds.push(edgeId);
	} else {
		adjacency.set(vertexId, [edgeId]);
	}
}

function edgeLength(edge, vertices) {
	const start = vertices[edge.start];
	const end = vertices[edge.end];

	return Math.hypot(
		start[0] - end[0],
		start[1] - end[1],
		start[2] - end[2],
	);
}

function createAdjacency(edges, removed = new Set()) {
	const adjacency = new Map();

	for (let edgeId = 0; edgeId < edges.length; edgeId++) {
		if (removed.has(edgeId)) {
			continue;
		}

		const edge = edges[edgeId];

		addAdjacentEdge(adjacency, edge.start, edgeId);
		addAdjacentEdge(adjacency, edge.end, edgeId);
	}

	return adjacency;
}

function walkDanglingBranch(edges, vertices, adjacency, startVertexId, startEdgeId) {
	const edgeIds = [];
	let currentVertexId = startVertexId;
	let currentEdgeId = startEdgeId;
	let length = 0;

	while (currentEdgeId !== undefined && !edgeIds.includes(currentEdgeId)) {
		const edge = edges[currentEdgeId];
		const nextVertexId = edge.start === currentVertexId ? edge.end : edge.start;

		edgeIds.push(currentEdgeId);
		length += edgeLength(edge, vertices);

		const nextEdges = adjacency.get(nextVertexId) ?? [];

		if (nextEdges.length !== 2) {
			break;
		}

		currentEdgeId = nextEdges.find((edgeId) => edgeId !== currentEdgeId);
		currentVertexId = nextVertexId;
	}

	return {
		edgeIds,
		length,
	};
}

export function removeDanglingEdges(edges, vertices, protectedEdges) {
	if (MAXIMUM_DANGLING_BRANCH_LENGTH <= 0) {
		return edges;
	}

	const removed = new Set();
	let changed = true;

	while (changed) {
		changed = false;

		const adjacency = createAdjacency(edges, removed);

		for (const [vertexId, edgeIds] of adjacency) {
			if (edgeIds.length !== 1 || removed.has(edgeIds[0])) {
				continue;
			}

			const branch = walkDanglingBranch(edges, vertices, adjacency, vertexId, edgeIds[0]);

			if (branch.length > MAXIMUM_DANGLING_BRANCH_LENGTH || branch.edgeIds.some((edgeId) => protectedEdges.has(edgeId))) {
				continue;
			}

			for (const edgeId of branch.edgeIds) {
				removed.add(edgeId);
			}

			changed = true;
			break;
		}
	}

	return edges.filter((_, edgeId) => !removed.has(edgeId));
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

export function createPaths(edges) {
	const adjacency = createAdjacency(edges);
	const visited = new Set();
	const paths = [];

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

function projectedArea(path) {
	let area = 0;

	for (let index = 0, previous = path.length - 1; index < path.length; previous = index++) {
		area += path[previous][0] * path[index][1] - path[index][0] * path[previous][1];
	}

	return Math.abs(area) / 2;
}

function triangleArea3d(origin, left, right) {
	const leftVector = [
		left[0] - origin[0],
		left[1] - origin[1],
		left[2] - origin[2],
	];
	const rightVector = [
		right[0] - origin[0],
		right[1] - origin[1],
		right[2] - origin[2],
	];
	const cross = [
		leftVector[1] * rightVector[2] - leftVector[2] * rightVector[1],
		leftVector[2] * rightVector[0] - leftVector[0] * rightVector[2],
		leftVector[0] * rightVector[1] - leftVector[1] * rightVector[0],
	];

	return Math.hypot(cross[0], cross[1], cross[2]) / 2;
}

function spatialArea(path) {
	const origin = path[0];
	let area = 0;

	for (let index = 1; index < path.length - 2; index++) {
		area += triangleArea3d(origin, path[index], path[index + 1]);
	}

	return area;
}

function isClosed(path) {
	const start = path[0];
	const end = path[path.length - 1];

	return start
		&& end
		&& Math.hypot(start[0] - end[0], start[1] - end[1], start[2] - end[2]) <= EPSILON;
}

export function isCollapsedPath(path) {
	return isClosed(path)
		&& projectedArea(path) <= EPSILON
		&& spatialArea(path) <= MINIMUM_COLLAPSED_AREA;
}

export function isReferenceInternalOpenPath(path, referenceEdges) {
	if (isClosed(path)) {
		return false;
	}

	for (let index = 1; index < path.length; index++) {
		if (!segmentLiesOnReferenceInternalEdge(path[index - 1], path[index], referenceEdges)) {
			return false;
		}
	}

	return true;
}
