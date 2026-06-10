const EDGE_ADJACENCY_TOLERANCE = 1e-4;
const EDGE_ADJACENCY_GRID_SIZE = 4;

function triangleArea3d(points) {
	const [a, b, c] = points;
	const ux = b[0] - a[0];
	const uy = b[1] - a[1];
	const uz = b[2] - a[2];
	const vx = c[0] - a[0];
	const vy = c[1] - a[1];
	const vz = c[2] - a[2];

	return Math.hypot(
		uy * vz - uz * vy,
		uz * vx - ux * vz,
		ux * vy - uy * vx,
	) / 2;
}

function trianglePoints(mesh, triangleIndex) {
	return mesh.triangles[triangleIndex].map((index) => mesh.vertices[index - 1]);
}

function edgeLength2d(edge) {
	return Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
}

function pointLineDistance2d(point, edge, length) {
	const area = Math.abs(
		(edge.b[0] - edge.a[0]) * (point[1] - edge.a[1])
		- (edge.b[1] - edge.a[1]) * (point[0] - edge.a[0])
	);

	return area / length;
}

function edgeParameter(point, edge) {
	const dx = edge.b[0] - edge.a[0];
	const dy = edge.b[1] - edge.a[1];
	const lengthSquared = dx * dx + dy * dy;

	return ((point[0] - edge.a[0]) * dx + (point[1] - edge.a[1]) * dy) / lengthSquared;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function edgePoint(edge, amount) {
	return [
		edge.a[0] + (edge.b[0] - edge.a[0]) * amount,
		edge.a[1] + (edge.b[1] - edge.a[1]) * amount,
		edge.a[2] + (edge.b[2] - edge.a[2]) * amount,
	];
}

function overlappingEdgeLength(left, right) {
	const leftLength = edgeLength2d(left);
	const rightLength = edgeLength2d(right);

	if (leftLength <= EDGE_ADJACENCY_TOLERANCE || rightLength <= EDGE_ADJACENCY_TOLERANCE) {
		return 0;
	}

	if (
		pointLineDistance2d(right.a, left, leftLength) > EDGE_ADJACENCY_TOLERANCE
		|| pointLineDistance2d(right.b, left, leftLength) > EDGE_ADJACENCY_TOLERANCE
	) {
		return 0;
	}

	const start = Math.max(0, Math.min(edgeParameter(right.a, left), edgeParameter(right.b, left)));
	const end = Math.min(1, Math.max(edgeParameter(right.a, left), edgeParameter(right.b, left)));
	const overlap = (end - start) * leftLength;

	if (overlap <= EDGE_ADJACENCY_TOLERANCE) {
		return 0;
	}

	const sample = edgePoint(left, (start + end) / 2);
	const rightAmount = clamp(edgeParameter(sample, right), 0, 1);
	const rightSample = edgePoint(right, rightAmount);

	return Math.abs(sample[2] - rightSample[2]) <= EDGE_ADJACENCY_TOLERANCE
		? overlap
		: 0;
}

function edgeBounds(edge) {
	return {
		minX: Math.min(edge.a[0], edge.b[0]) - EDGE_ADJACENCY_TOLERANCE,
		minY: Math.min(edge.a[1], edge.b[1]) - EDGE_ADJACENCY_TOLERANCE,
		maxX: Math.max(edge.a[0], edge.b[0]) + EDGE_ADJACENCY_TOLERANCE,
		maxY: Math.max(edge.a[1], edge.b[1]) + EDGE_ADJACENCY_TOLERANCE,
	};
}

function edgeGridKeys(edge) {
	const bounds = edgeBounds(edge);
	const minX = Math.floor(bounds.minX / EDGE_ADJACENCY_GRID_SIZE);
	const minY = Math.floor(bounds.minY / EDGE_ADJACENCY_GRID_SIZE);
	const maxX = Math.floor(bounds.maxX / EDGE_ADJACENCY_GRID_SIZE);
	const maxY = Math.floor(bounds.maxY / EDGE_ADJACENCY_GRID_SIZE);
	const keys = [];

	for (let x = minX; x <= maxX; x++) {
		for (let y = minY; y <= maxY; y++) {
			keys.push(`${x},${y}`);
		}
	}

	return keys;
}

function createEdge(mesh, triangleIndex, startIndex, endIndex, index) {
	return {
		index,
		triangleIndex,
		a: mesh.vertices[startIndex - 1],
		b: mesh.vertices[endIndex - 1],
	};
}

function addAdjacency(adjacency, left, right) {
	if (left === right) {
		return;
	}

	adjacency[left].add(right);
	adjacency[right].add(left);
}

function triangleAdjacency(mesh) {
	const adjacency = mesh.triangles.map(() => new Set());
	const edgeGrid = new Map();
	const edges = [];

	for (const [triangleIndex, triangle] of mesh.triangles.entries()) {
		for (const [startIndex, endIndex] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
			const edge = createEdge(mesh, triangleIndex, startIndex, endIndex, edges.length);
			const seenCandidates = new Set();
			const keys = edgeGridKeys(edge);

			edges.push(edge);

			for (const key of keys) {
				const candidates = edgeGrid.get(key) ?? [];

				for (const candidate of candidates) {
					if (seenCandidates.has(candidate.index)) {
						continue;
					}

					seenCandidates.add(candidate.index);

					if (overlappingEdgeLength(edge, candidate) > EDGE_ADJACENCY_TOLERANCE) {
						addAdjacency(adjacency, edge.triangleIndex, candidate.triangleIndex);
					}
				}
			}

			for (const key of keys) {
				const candidates = edgeGrid.get(key) ?? [];

				candidates.push(edge);
				edgeGrid.set(key, candidates);
			}
		}
	}

	return adjacency;
}

export function createTriangleComponents(mesh) {
	const adjacency = triangleAdjacency(mesh);
	const visited = new Set();
	const components = [];

	for (let triangleIndex = 0; triangleIndex < mesh.triangles.length; triangleIndex++) {
		if (visited.has(triangleIndex)) {
			continue;
		}

		const queue = [triangleIndex];
		const triangles = [];
		let area = 0;
		let hasOriginalSurface = false;

		visited.add(triangleIndex);

		for (let index = 0; index < queue.length; index++) {
			const current = queue[index];

			triangles.push(current);
			area += triangleArea3d(trianglePoints(mesh, current));
			hasOriginalSurface ||= mesh.sources[current] === "original";

			for (const next of adjacency[current]) {
				if (visited.has(next)) {
					continue;
				}

				visited.add(next);
				queue.push(next);
			}
		}

		components.push({
			triangles,
			area,
			hasOriginalSurface,
		});
	}

	return components;
}
