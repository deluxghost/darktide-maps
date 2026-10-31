import {
	navmeshGeometry,
	boundaryGraph,
	navmeshInternalEdgeGroups,
	lineGroupKey,
	segmentLiesOnReferenceInternalEdge,
} from "./geometry.mjs";
import {
	removeDanglingEdges,
	createPaths,
	isCollapsedPath,
	isReferenceInternalOpenPath,
} from "./paths.mjs";

export function createBoundaryPaths(navmesh, referenceNavmesh = null, removed = null) {
	const {positions, indices} = navmeshGeometry(navmesh);
	const {edges, vertices} = boundaryGraph(positions, indices);
	const referenceEdges = referenceNavmesh ? navmeshInternalEdgeGroups(referenceNavmesh) : null;
	const cutEdges = new Map();
	if (removed) {
		const graph = boundaryGraph(new Float32Array(removed.mesh.positions.map((value, index) =>
			index % 3 === 2 ? value - removed.verticalOffset : value)), removed.mesh.indices);
		for (const edge of graph.edges) {
			const start = graph.vertices[edge.start], end = graph.vertices[edge.end];
			const key = lineGroupKey(start, end);
			if (!key) continue;
			const group = cutEdges.get(key) ?? [];
			group.push([start, end]);
			cutEdges.set(key, group);
		}
	}
	const protectedEdges = new Set(edges.flatMap((edge, id) =>
		segmentLiesOnReferenceInternalEdge(vertices[edge.start], vertices[edge.end], cutEdges) ? [id] : []));
	const cleanEdges = removeDanglingEdges(edges, vertices, protectedEdges);

	const paths = createPaths(cleanEdges)
		.map((vertexPath) => vertexPath.map((vertexId) => vertices[vertexId]))
		.filter((path) => !isCollapsedPath(path));

	return referenceEdges
		? paths.filter((path) => !isReferenceInternalOpenPath(path, referenceEdges)
			|| path.some((point, index) => index > 0 && segmentLiesOnReferenceInternalEdge(path[index - 1], point, cutEdges)))
		: paths;
}
