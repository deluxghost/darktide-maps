import {createComponents} from "./components.mjs";
import {
	distance2d,
	midpoint,
	pointToSegmentDistance2d,
	preciseEdgeKey,
	scale,
	triangleArea,
	triangleCenter,
} from "./geometry.mjs";
import {componentVolumeEdges, EDGE_SAMPLE_AMOUNTS, edgeIntersectsVolume} from "./volumes.mjs";

const SPLIT_RULES = {
	localRadius: 10,
	minArea: 8,
	minContactEdges: 2,
	minComponentLength: 20,
};
const FLOOR_VERTICAL_TOLERANCE = 2;
const NEAR_SPLIT_RULES = {
	maxHorizontalDistance: 8.5,
};
const BOUNDARY_RULES = {
	clearanceDistance: 0.4,
};
const INTERNAL_BOUNDARY_RULES = {
	minSupportBalance: 0.5,
};

function createNavAnalysis(navmesh) {
	const triangles = navmesh.triangles.map((triangle, index) => {
		const vertices = [
			navmesh.vertices[triangle[0] - 1],
			navmesh.vertices[triangle[1] - 1],
			navmesh.vertices[triangle[2] - 1],
		];

		return {
			index,
			center: triangleCenter(navmesh.vertices, triangle),
			area: triangleArea(vertices[0], vertices[1], vertices[2]),
		};
	});
	const edgeToTriangles = new Map();

	for (let triangleIndex = 0; triangleIndex < navmesh.triangles.length; triangleIndex++) {
		const triangle = navmesh.triangles[triangleIndex];
		const vertices = [
			navmesh.vertices[triangle[0] - 1],
			navmesh.vertices[triangle[1] - 1],
			navmesh.vertices[triangle[2] - 1],
		];

		for (const [a, b] of [[vertices[0], vertices[1]], [vertices[1], vertices[2]], [vertices[2], vertices[0]]]) {
			const key = preciseEdgeKey(a, b);
			const group = edgeToTriangles.get(key) ?? [];

			group.push(triangleIndex);
			edgeToTriangles.set(key, group);
		}
	}

	return {
		edgeToTriangles,
		boundaryEdges: [...edgeToTriangles.entries()]
			.filter(([, triangleIndexes]) => triangleIndexes.length === 1)
			.map(([edgeKey]) => edgeKey.split("|").map((position) => position.split(",").map(Number))),
		triangles,
	};
}

function nearestBoundaryDistance2d(point, boundaryEdges) {
	let result = Infinity;

	for (const [a, b] of boundaryEdges) {
		const boundaryHeight = (a[2] + b[2]) / 2;

		if (Math.abs(point[2] - boundaryHeight) > FLOOR_VERTICAL_TOLERANCE) {
			continue;
		}

		result = Math.min(result, pointToSegmentDistance2d(point, a, b));
	}

	return result;
}

function componentCenter(component) {
	const center = [0, 0, 0];
	let count = 0;

	for (const edge of component.edges) {
		const edgeCenter = midpoint(edge.a, edge.b);

		center[0] += edgeCenter[0];
		center[1] += edgeCenter[1];
		center[2] += edgeCenter[2];
		count++;
	}

	return scale(center, 1 / count);
}

function componentProbeRatio(component, value) {
	const matching = component.edges.filter((edge) => edge.side_probe === value).length;

	return matching / component.edges.length;
}

function isPartialSurfaceComponent(component) {
	return componentProbeRatio(component, "partial") === 1;
}

function isStrongPartialSplit(split) {
	const minimumArea = SPLIT_RULES.minArea * (SPLIT_RULES.minContactEdges + 1);

	return split.meaningfulAreas.length >= 2
		&& Math.min(...split.meaningfulAreas) >= minimumArea;
}

function componentBlockedKeys(component) {
	return new Set(component.edges.map((edge) => preciseEdgeKey(edge.a, edge.b)));
}

function localTriangleSet(navAnalysis, center) {
	const local = new Set();

	for (const triangle of navAnalysis.triangles) {
		if (distance2d(triangle.center, center) <= SPLIT_RULES.localRadius) {
			local.add(triangle.index);
		}
	}

	return local;
}

function localAdjacency(navAnalysis, localTriangles, blockedKeys) {
	const adjacency = new Map();

	for (const triangleIndex of localTriangles) {
		adjacency.set(triangleIndex, new Set());
	}

	for (const [edgeKey, triangleIndexes] of navAnalysis.edgeToTriangles.entries()) {
		if (blockedKeys.has(edgeKey) || triangleIndexes.length !== 2) {
			continue;
		}

		const [left, right] = triangleIndexes;

		if (!localTriangles.has(left) || !localTriangles.has(right)) {
			continue;
		}

		adjacency.get(left).add(right);
		adjacency.get(right).add(left);
	}

	return adjacency;
}

function visitComponent(start, adjacency, visited) {
	const queue = [start];
	const result = [];

	visited.add(start);

	for (let index = 0; index < queue.length; index++) {
		const current = queue[index];

		result.push(current);

		for (const next of adjacency.get(current) ?? []) {
			if (visited.has(next)) {
				continue;
			}

			visited.add(next);
			queue.push(next);
		}
	}

	return result;
}

function splitComponents(navAnalysis, localTriangles, adjacency) {
	const visited = new Set();
	const components = [];

	for (const triangleIndex of localTriangles) {
		if (visited.has(triangleIndex)) {
			continue;
		}

		const triangleIndexes = visitComponent(triangleIndex, adjacency, visited);
		const area = triangleIndexes.reduce((total, index) => total + navAnalysis.triangles[index].area, 0);

		components.push({
			triangleIndexes: new Set(triangleIndexes),
			area,
		});
	}

	return components;
}

function componentContactCounts(navAnalysis, splitComponentsList, blockedKeys) {
	const counts = new Map(splitComponentsList.map((component, index) => [index, 0]));

	for (const [edgeKey, triangleIndexes] of navAnalysis.edgeToTriangles.entries()) {
		if (!blockedKeys.has(edgeKey)) {
			continue;
		}

		for (const triangleIndex of triangleIndexes) {
			const splitIndex = splitComponentsList.findIndex((component) => component.triangleIndexes.has(triangleIndex));

			if (splitIndex !== -1) {
				counts.set(splitIndex, counts.get(splitIndex) + 1);
			}
		}
	}

	return counts;
}

function afterSplitsByBaseSplit(baseSplits, afterSplits) {
	const result = baseSplits.map(() => []);

	for (const afterSplit of afterSplits) {
		const firstTriangle = afterSplit.triangleIndexes.values().next().value;
		const baseIndex = baseSplits.findIndex((baseSplit) => baseSplit.triangleIndexes.has(firstTriangle));

		if (baseIndex !== -1) {
			result[baseIndex].push(afterSplit);
		}
	}

	return result;
}

function analyzeSplit(component, navAnalysis) {
	const center = componentCenter(component);
	const localTriangles = localTriangleSet(navAnalysis, center);

	const blockedKeys = componentBlockedKeys(component);
	const baseAdjacency = localAdjacency(navAnalysis, localTriangles, new Set());
	const baseSplits = splitComponents(navAnalysis, localTriangles, baseAdjacency);
	const adjacency = localAdjacency(navAnalysis, localTriangles, blockedKeys);
	const afterSplits = splitComponents(navAnalysis, localTriangles, adjacency);

	if (afterSplits.length <= baseSplits.length) {
		return {
			splits: false,
			meaningfulGroups: [],
			meaningfulAreas: [],
		};
	}

	const contactCounts = componentContactCounts(navAnalysis, afterSplits, blockedKeys);
	const groupedAfterSplits = afterSplitsByBaseSplit(baseSplits, afterSplits);
	const meaningfulSplitIndexes = new Set();
	const meaningfulGroups = [];

	for (const splits of groupedAfterSplits) {
		const currentIndexes = splits.map((split) => afterSplits.indexOf(split));
		const meaningfulIndexes = currentIndexes.filter((splitIndex) => {
			const split = afterSplits[splitIndex];

			return split.area >= SPLIT_RULES.minArea
				&& contactCounts.get(splitIndex) >= SPLIT_RULES.minContactEdges;
		});

		meaningfulGroups.push(meaningfulIndexes);

		if (meaningfulIndexes.length >= 2) {
			for (const splitIndex of meaningfulIndexes) {
				meaningfulSplitIndexes.add(splitIndex);
			}
		}
	}

	const meaningfulAreas = [...meaningfulSplitIndexes].map((splitIndex) => afterSplits[splitIndex].area);

	if (meaningfulSplitIndexes.size < 2) {
		return {
			splits: false,
			meaningfulGroups,
			meaningfulAreas,
		};
	}

	return {
		splits: true,
		meaningfulGroups,
		meaningfulAreas,
	};
}

function edgeBoundaryClearanceSampleCount(edge, navAnalysis) {
	let closeSamples = 0;

	for (const amount of EDGE_SAMPLE_AMOUNTS) {
		const sample = [
			edge.a[0] + (edge.b[0] - edge.a[0]) * amount,
			edge.a[1] + (edge.b[1] - edge.a[1]) * amount,
			edge.a[2] + (edge.b[2] - edge.a[2]) * amount,
		];
		const distance = nearestBoundaryDistance2d(sample, navAnalysis.boundaryEdges);

		if (distance <= BOUNDARY_RULES.clearanceDistance) {
			closeSamples++;
		}
	}

	return closeSamples;
}

function isBoundaryClearanceEdge(edge, navAnalysis) {
	return edgeBoundaryClearanceSampleCount(edge, navAnalysis) > EDGE_SAMPLE_AMOUNTS.length / 2;
}

function shouldKeepRenderedFragment(component) {
	return component.totalLength >= SPLIT_RULES.minArea;
}

function componentDistance(left, right) {
	let horizontal = Infinity;
	let vertical = Infinity;

	for (const leftEdge of left.edges) {
		for (const rightEdge of right.edges) {
			for (const leftPosition of [leftEdge.a, leftEdge.b]) {
				for (const rightPosition of [rightEdge.a, rightEdge.b]) {
					const currentHorizontal = distance2d(leftPosition, rightPosition);

					if (currentHorizontal < horizontal) {
						horizontal = currentHorizontal;
						vertical = Math.abs(leftPosition[2] - rightPosition[2]);
					}
				}
			}
		}
	}

	return {horizontal, vertical};
}

function isNearSplitComponent(component, splitComponents) {
	return splitComponents.some((splitComponent) => {
		const distance = componentDistance(component, splitComponent);

		return distance.horizontal <= NEAR_SPLIT_RULES.maxHorizontalDistance
			&& distance.vertical <= FLOOR_VERTICAL_TOLERANCE;
	});
}

function componentSupportSides(component, navAnalysis) {
	const points = component.edges.flatMap((edge) => [edge.a, edge.b]);
	const center = componentCenter(component);
	const sideDistance = BOUNDARY_RULES.clearanceDistance / 2;
	let xx = 0;
	let xy = 0;
	let yy = 0;

	for (const point of points) {
		const x = point[0] - center[0];
		const y = point[1] - center[1];

		xx += x * x;
		xy += x * y;
		yy += y * y;
	}

	const angle = Math.atan2(2 * xy, xx - yy) / 2;
	const normal = [-Math.sin(angle), Math.cos(angle)];
	let positiveArea = 0;
	let negativeArea = 0;

	for (const edge of component.edges) {
		const triangleIndexes = navAnalysis.edgeToTriangles.get(preciseEdgeKey(edge.a, edge.b)) ?? [];

		for (const triangleIndex of triangleIndexes) {
			const triangle = navAnalysis.triangles[triangleIndex];
			const signedDistance = (triangle.center[0] - center[0]) * normal[0]
				+ (triangle.center[1] - center[1]) * normal[1];

			if (signedDistance > sideDistance) {
				positiveArea += triangle.area;
			} else if (signedDistance < -sideDistance) {
				negativeArea += triangle.area;
			}
		}
	}

	return {
		positiveArea,
		negativeArea,
	};
}

function hasTwoSidedSupport(component, navAnalysis) {
	const support = componentSupportSides(component, navAnalysis);
	const balance = Math.min(support.positiveArea, support.negativeArea)
		/ Math.max(support.positiveArea, support.negativeArea, Number.EPSILON);

	return support.positiveArea > 0
		&& support.negativeArea > 0
		&& balance >= INTERNAL_BOUNDARY_RULES.minSupportBalance;
}

function isInternalBoundaryComponent(component, navAnalysis, split) {
	const meaningfulGroups = split.meaningfulGroups.filter((group) => group.length > 0);

	if (isPartialSurfaceComponent(component) && component.totalLength >= SPLIT_RULES.minComponentLength) {
		return false;
	}

	return meaningfulGroups.length === 1
		&& component.totalLength >= SPLIT_RULES.minArea
		&& hasTwoSidedSupport(component, navAnalysis);
}

function isSplitComponent(component, navAnalysis) {
	const split = analyzeSplit(component, navAnalysis);

	if (!split.splits) {
		return isInternalBoundaryComponent(component, navAnalysis, split);
	}

	if (component.totalLength < SPLIT_RULES.minComponentLength) {
		return false;
	}

	return !isPartialSurfaceComponent(component) || isStrongPartialSplit(split);
}

function componentIntersectsVolume(component, volumes) {
	return component.edges.some((edge) => edgeIntersectsVolume(edge, volumes));
}

function shouldKeepDoorComponent(component, doorEdges, includedEdges, navAnalysis) {
	const includedBlockRatio = SPLIT_RULES.minContactEdges + 1;
	const hasDominantIncludedBlock = includedEdges.length >= doorEdges.length * includedBlockRatio;

	return hasDominantIncludedBlock && analyzeSplit(component, navAnalysis).splits;
}

export function filterDoorEdges(edges, doors, includeVolumes, navmesh) {
	if (doors.length === 0) {
		return edges;
	}

	const navAnalysis = createNavAnalysis(navmesh);
	const components = createComponents(edges);

	return components.flatMap((component) => {
		const doorEdges = componentVolumeEdges(component, doors);

		if (doorEdges.length === 0) {
			return component.edges;
		}

		const includedEdges = componentVolumeEdges(component, includeVolumes);

		if (!shouldKeepDoorComponent(component, doorEdges, includedEdges, navAnalysis)) {
			return [];
		}

		return component.edges.filter((edge) => (
			!edgeIntersectsVolume(edge, doors)
			|| edgeIntersectsVolume(edge, includeVolumes)
		));
	});
}

export function filterEdges(edges, navmesh, includeVolumes) {
	const components = createComponents(edges);
	const navAnalysis = createNavAnalysis(navmesh);
	const includedComponents = components.filter((component) => (
		component.totalLength >= SPLIT_RULES.minComponentLength
		&& isPartialSurfaceComponent(component)
		&& componentIntersectsVolume(component, includeVolumes)
	));
	const splitComponents = components.filter((component) => isSplitComponent(component, navAnalysis));
	const keptComponents = components.filter((component) => (
		includedComponents.includes(component)
		|| splitComponents.includes(component)
		|| (!isPartialSurfaceComponent(component) && isNearSplitComponent(component, splitComponents))
	));
	const renderedEdges = keptComponents
		.flatMap((component) => component.edges)
		.filter((edge) => !isBoundaryClearanceEdge(edge, navAnalysis));
	const renderedFragments = createComponents(renderedEdges);
	const keptRenderedFragments = renderedFragments.filter((component) => shouldKeepRenderedFragment(component));
	const finalEdges = keptRenderedFragments.flatMap((component) => component.edges);

	return {
		components,
		includedComponents,
		splitComponents,
		keptComponents,
		renderedFragments,
		keptRenderedFragments,
		edges: finalEdges,
	};
}
