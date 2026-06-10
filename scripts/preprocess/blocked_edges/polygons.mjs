import {PREPROCESS_CONFIG} from "../config.mjs";
import {pointToSegmentDistance2d} from "./geometry.mjs";

const POLYGON_CONFIG = PREPROCESS_CONFIG.blockedEdges.polygons;
const EDGE_BRIDGE_SAMPLE_STEP_CELLS = 0.5;
const EDGE_BRIDGE_RADIUS_CELLS = 1;
const REQUIRED_POLYGON_CONFIG_KEYS = [
	"closeRadiusCells",
	"mergeDistanceCells",
	"mergeVerticalDistance",
	"simplifyToleranceCells",
	"minimumArea",
	"minimumSecondaryAreaRatio",
];

for (const key of REQUIRED_POLYGON_CONFIG_KEYS) {
	if (!Number.isFinite(POLYGON_CONFIG?.[key])) {
		throw new Error(`Missing blocked edge polygon config: ${key}`);
	}
}

function cellKey(x, y) {
	return `${x},${y}`;
}

function pointKey(point) {
	return `${point[0]},${point[1]}`;
}

function decodeCells(component) {
	if (!Array.isArray(component.rows)) {
		throw new Error(`Blocked edge sample component ${component.id} is missing rows.`);
	}

	const cells = new Set();

	for (const row of component.rows) {
		if (!Array.isArray(row.runs)) {
			throw new Error(`Blocked edge sample component ${component.id} has a row without runs.`);
		}

		for (const [start, end] of row.runs) {
			for (let x = start; x <= end; x++) {
				cells.add(cellKey(x, row.y));
			}
		}
	}

	return cells;
}

function decodedComponent(component) {
	const cells = decodeCells(component);
	const bounds = cellBounds(cells);

	return {
		component,
		cells,
		cell_size: component.cell_size,
		origin: component.origin,
		z: component.z,
		bounds: {
			minX: component.origin[0] + bounds.minX * component.cell_size,
			minY: component.origin[1] + bounds.minY * component.cell_size,
			maxX: component.origin[0] + (bounds.maxX + 1) * component.cell_size,
			maxY: component.origin[1] + (bounds.maxY + 1) * component.cell_size,
		},
	};
}

function edgeSample(edge, amount) {
	return [
		edge.a[0] + (edge.b[0] - edge.a[0]) * amount,
		edge.a[1] + (edge.b[1] - edge.a[1]) * amount,
		edge.a[2] + (edge.b[2] - edge.a[2]) * amount,
	];
}

function edgeBounds(edge) {
	return {
		minX: Math.min(edge.a[0], edge.b[0]),
		minY: Math.min(edge.a[1], edge.b[1]),
		minZ: Math.min(edge.a[2], edge.b[2]),
		maxX: Math.max(edge.a[0], edge.b[0]),
		maxY: Math.max(edge.a[1], edge.b[1]),
		maxZ: Math.max(edge.a[2], edge.b[2]),
		edge,
	};
}

function edgeBoundsCanTouchComponent(edge, component) {
	const margin = component.cell_size;

	return edge.maxX >= component.bounds.minX - margin
		&& edge.minX <= component.bounds.maxX + margin
		&& edge.maxY >= component.bounds.minY - margin
		&& edge.minY <= component.bounds.maxY + margin
		&& edge.maxZ >= component.z - margin
		&& edge.minZ <= component.z + margin;
}

function pointToCellDistance(point, component, x, y) {
	const minX = component.origin[0] + x * component.cell_size;
	const minY = component.origin[1] + y * component.cell_size;
	const maxX = minX + component.cell_size;
	const maxY = minY + component.cell_size;
	const dx = Math.max(0, minX - point[0], point[0] - maxX);
	const dy = Math.max(0, minY - point[1], point[1] - maxY);

	return Math.hypot(dx, dy);
}

function pointTouchesComponent(point, component) {
	const x = Math.floor((point[0] - component.origin[0]) / component.cell_size);
	const y = Math.floor((point[1] - component.origin[1]) / component.cell_size);

	for (let offsetY = -1; offsetY <= 1; offsetY++) {
		for (let offsetX = -1; offsetX <= 1; offsetX++) {
			const cellX = x + offsetX;
			const cellY = y + offsetY;

			if (!component.cells.has(cellKey(cellX, cellY))) {
				continue;
			}

			if (pointToCellDistance(point, component, cellX, cellY) <= component.cell_size) {
				return true;
			}
		}
	}

	return false;
}

function edgeTouchesComponent(edge, component) {
	for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
		const sample = edgeSample(edge, amount);

		if (Math.abs(sample[2] - component.z) <= component.cell_size && pointTouchesComponent(sample, component)) {
			return true;
		}
	}

	return false;
}

function selectedComponents(samples, edges) {
	const componentIds = new Set(edges
		.map((edge) => edge.component_id)
		.filter((id) => id !== undefined));
	const edgeBoundsList = edges.map(edgeBounds);
	const components = samples.components.map(decodedComponent);
	const selected = [];

	for (const component of components) {
		if (componentIds.has(component.component.id)) {
			selected.push(component);
			continue;
		}

		if (edgeBoundsList.some((entry) => (
			edgeBoundsCanTouchComponent(entry, component)
			&& edgeTouchesComponent(entry.edge, component)
		))) {
			selected.push(component);
		}
	}

	return selected;
}

function cellBounds(cells) {
	const bounds = {
		minX: Infinity,
		minY: Infinity,
		maxX: -Infinity,
		maxY: -Infinity,
	};

	for (const key of cells) {
		const [x, y] = key.split(",").map(Number);

		bounds.minX = Math.min(bounds.minX, x);
		bounds.minY = Math.min(bounds.minY, y);
		bounds.maxX = Math.max(bounds.maxX, x);
		bounds.maxY = Math.max(bounds.maxY, y);
	}

	return bounds;
}

function dilateCells(cells, radius) {
	if (radius <= 0 || cells.size === 0) {
		return new Set(cells);
	}

	const result = new Set();
	const radiusSquared = radius * radius;

	for (const key of cells) {
		const [x, y] = key.split(",").map(Number);

		for (let offsetY = -radius; offsetY <= radius; offsetY++) {
			for (let offsetX = -radius; offsetX <= radius; offsetX++) {
				if (offsetX * offsetX + offsetY * offsetY <= radiusSquared) {
					result.add(cellKey(x + offsetX, y + offsetY));
				}
			}
		}
	}

	return result;
}

function erodeCells(cells, radius) {
	if (radius <= 0 || cells.size === 0) {
		return new Set(cells);
	}

	const result = new Set();
	const radiusSquared = radius * radius;
	const bounds = cellBounds(cells);

	for (let y = bounds.minY; y <= bounds.maxY; y++) {
		for (let x = bounds.minX; x <= bounds.maxX; x++) {
			let keep = true;

			for (let offsetY = -radius; offsetY <= radius && keep; offsetY++) {
				for (let offsetX = -radius; offsetX <= radius; offsetX++) {
					if (offsetX * offsetX + offsetY * offsetY > radiusSquared) {
						continue;
					}

					if (!cells.has(cellKey(x + offsetX, y + offsetY))) {
						keep = false;
						break;
					}
				}
			}

			if (keep) {
				result.add(cellKey(x, y));
			}
		}
	}

	return result;
}

function closeCells(cells) {
	const radius = POLYGON_CONFIG.closeRadiusCells;

	return erodeCells(dilateCells(cells, radius), radius);
}

function edgeLength2d(edge) {
	return Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
}

function addCellBlock(cells, x, y, radius) {
	for (let offsetY = -radius; offsetY <= radius; offsetY++) {
		for (let offsetX = -radius; offsetX <= radius; offsetX++) {
			cells.add(cellKey(x + offsetX, y + offsetY));
		}
	}
}

function addEdgeBridgeCells(cells, component, edges) {
	const result = new Set(cells);
	const sampleStep = component.cell_size * EDGE_BRIDGE_SAMPLE_STEP_CELLS;

	for (const entry of edges) {
		if (!edgeBoundsCanTouchComponent(entry, component) || !edgeTouchesComponent(entry.edge, component)) {
			continue;
		}

		const sampleCount = Math.max(1, Math.ceil(edgeLength2d(entry.edge) / sampleStep));

		for (let index = 0; index <= sampleCount; index++) {
			const point = edgeSample(entry.edge, index / sampleCount);

			if (Math.abs(point[2] - component.z) > component.cell_size) {
				continue;
			}

			const x = Math.floor((point[0] - component.origin[0]) / component.cell_size);
			const y = Math.floor((point[1] - component.origin[1]) / component.cell_size);

			addCellBlock(result, x, y, EDGE_BRIDGE_RADIUS_CELLS);
		}
	}

	return result;
}

function boundsGap(left, right) {
	const x = Math.max(0, Math.max(left.bounds.minX - right.bounds.maxX, right.bounds.minX - left.bounds.maxX));
	const y = Math.max(0, Math.max(left.bounds.minY - right.bounds.maxY, right.bounds.minY - left.bounds.maxY));

	return Math.hypot(x, y);
}

function componentsCanMerge(left, right) {
	const cellSize = left.component.cell_size;
	const maxGap = POLYGON_CONFIG.mergeDistanceCells * cellSize;
	const maxVertical = POLYGON_CONFIG.mergeVerticalDistance;

	return boundsGap(left, right) <= maxGap
		&& Math.abs(left.component.z - right.component.z) <= maxVertical;
}

function mergeBounds(left, right) {
	return {
		minX: Math.min(left.minX, right.minX),
		minY: Math.min(left.minY, right.minY),
		maxX: Math.max(left.maxX, right.maxX),
		maxY: Math.max(left.maxY, right.maxY),
	};
}

function createComponentGroups(components) {
	const groups = [];

	for (const component of components) {
		const matching = groups.filter((group) => group.components.some((entry) => componentsCanMerge(entry, component)));

		if (matching.length === 0) {
			groups.push({
				components: [component],
				bounds: component.bounds,
			});
			continue;
		}

		const target = matching[0];

		target.components.push(component);
		target.bounds = mergeBounds(target.bounds, component.bounds);

		for (const group of matching.slice(1)) {
			target.components.push(...group.components);
			target.bounds = mergeBounds(target.bounds, group.bounds);
			groups.splice(groups.indexOf(group), 1);
		}
	}

	return groups;
}

function groupCells(group) {
	const cellSize = group.components[0].component.cell_size;
	const origin = [group.bounds.minX, group.bounds.minY];
	const cells = new Set();
	let weightedZ = 0;
	let cellCount = 0;

	for (const entry of group.components) {
		const component = entry.component;

		for (const key of entry.cells) {
			const [x, y] = key.split(",").map(Number);
			const worldX = component.origin[0] + (x + 0.5) * component.cell_size;
			const worldY = component.origin[1] + (y + 0.5) * component.cell_size;
			const groupX = Math.floor((worldX - origin[0]) / cellSize);
			const groupY = Math.floor((worldY - origin[1]) / cellSize);

			cells.add(cellKey(groupX, groupY));
			weightedZ += component.z;
			cellCount++;
		}
	}

	return {
		cell_size: cellSize,
		origin,
		z: weightedZ / cellCount,
		cells,
		bounds: group.bounds,
	};
}

function addBoundaryEdge(edges, start, end) {
	const key = `${pointKey(start)}|${pointKey(end)}`;

	edges.set(key, {start, end});
}

function boundaryEdges(cells) {
	const edges = new Map();

	for (const key of cells) {
		const [x, y] = key.split(",").map(Number);

		if (!cells.has(cellKey(x, y - 1))) {
			addBoundaryEdge(edges, [x, y], [x + 1, y]);
		}

		if (!cells.has(cellKey(x + 1, y))) {
			addBoundaryEdge(edges, [x + 1, y], [x + 1, y + 1]);
		}

		if (!cells.has(cellKey(x, y + 1))) {
			addBoundaryEdge(edges, [x + 1, y + 1], [x, y + 1]);
		}

		if (!cells.has(cellKey(x - 1, y))) {
			addBoundaryEdge(edges, [x, y + 1], [x, y]);
		}
	}

	return [...edges.values()];
}

function popNextEdge(byStart, point) {
	const key = pointKey(point);
	const edges = byStart.get(key);

	if (!edges?.length) {
		return null;
	}

	const edge = edges.pop();

	if (edges.length === 0) {
		byStart.delete(key);
	}

	return edge;
}

function traceLoops(edges) {
	const byStart = new Map();
	const loops = [];

	for (const edge of edges) {
		const key = pointKey(edge.start);
		const list = byStart.get(key) ?? [];

		list.push(edge);
		byStart.set(key, list);
	}

	while (byStart.size > 0) {
		const firstList = byStart.values().next().value;
		const first = firstList[firstList.length - 1];
		const loop = [first.start];
		let current = first.start;

		while (true) {
			const edge = popNextEdge(byStart, current);

			if (!edge) {
				break;
			}

			current = edge.end;

			if (pointKey(current) === pointKey(loop[0])) {
				break;
			}

			loop.push(current);
		}

		if (loop.length >= 3) {
			loops.push(loop);
		}
	}

	return loops;
}

function isCollinear(previous, current, next) {
	return (current[0] - previous[0]) * (next[1] - current[1])
		=== (current[1] - previous[1]) * (next[0] - current[0]);
}

function removeCollinear(points) {
	return points.filter((point, index) => {
		const previous = points[(index + points.length - 1) % points.length];
		const next = points[(index + 1) % points.length];

		return !isCollinear(previous, point, next);
	});
}

function douglasPeucker(points, tolerance) {
	if (points.length <= 2) {
		return points;
	}

	let maxDistance = 0;
	let splitIndex = 0;

	for (let index = 1; index < points.length - 1; index++) {
		const distance = pointToSegmentDistance2d(points[index], points[0], points[points.length - 1]);

		if (distance > maxDistance) {
			maxDistance = distance;
			splitIndex = index;
		}
	}

	if (maxDistance <= tolerance) {
		return [points[0], points[points.length - 1]];
	}

	const left = douglasPeucker(points.slice(0, splitIndex + 1), tolerance);
	const right = douglasPeucker(points.slice(splitIndex), tolerance);

	return left.slice(0, -1).concat(right);
}

function simplifyLoop(points, tolerance) {
	const withoutCollinear = removeCollinear(points);

	if (withoutCollinear.length <= 3) {
		return withoutCollinear;
	}

	let bestIndex = 0;

	for (let index = 1; index < withoutCollinear.length; index++) {
		const point = withoutCollinear[index];
		const best = withoutCollinear[bestIndex];

		if (point[0] < best[0] || (point[0] === best[0] && point[1] < best[1])) {
			bestIndex = index;
		}
	}

	const opened = withoutCollinear
		.slice(bestIndex)
		.concat(withoutCollinear.slice(0, bestIndex), [withoutCollinear[bestIndex]]);
	const simplified = douglasPeucker(opened, tolerance).slice(0, -1);

	return simplified.length >= 3 ? removeCollinear(simplified) : withoutCollinear;
}

function toWorldLoop(component, loop) {
	return loop.map((point) => [
		component.origin[0] + point[0] * component.cell_size,
		component.origin[1] + point[1] * component.cell_size,
	]);
}

function polygonArea(points) {
	let area = 0;

	for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
		area += points[previous][0] * points[index][1] - points[index][0] * points[previous][1];
	}

	return Math.abs(area) / 2;
}

function sortLoopsByArea(loops) {
	return [...loops].sort((left, right) => polygonArea(right) - polygonArea(left));
}

function keepPrimaryLoops(loops) {
	if (loops.length <= 1) {
		return loops;
	}

	const largestArea = polygonArea(loops[0]);
	const minimumSecondaryArea = largestArea * POLYGON_CONFIG.minimumSecondaryAreaRatio;

	return loops.filter((loop, index) => index === 0 || polygonArea(loop) >= minimumSecondaryArea);
}

export function createSamplePolygons(samples, edges) {
	if (!Array.isArray(samples?.components)) {
		throw new Error("Blocked edge dump is missing sample components.");
	}

	const polygons = [];
	let polygonCount = 0;
	const components = selectedComponents(samples, edges);
	const groups = createComponentGroups(components);
	const edgeBoundsList = edges.map(edgeBounds);

	for (const group of groups) {
		const component = groupCells(group);
		const cells = closeCells(addEdgeBridgeCells(component.cells, component, edgeBoundsList));
		const loops = keepPrimaryLoops(sortLoopsByArea(
			traceLoops(boundaryEdges(cells)).map((loop) => toWorldLoop(component, loop)),
		));
		const tolerance = POLYGON_CONFIG.simplifyToleranceCells * component.cell_size;

		for (const loop of loops) {
			const points = simplifyLoop(loop, tolerance);

			if (points.length < 3 || polygonArea(points) < POLYGON_CONFIG.minimumArea) {
				continue;
			}

			polygons.push({
				points,
				z: component.z,
				cellSize: component.cell_size,
			});
			polygonCount++;
		}
	}

	return {
		polygons,
		polygonCount,
	};
}
