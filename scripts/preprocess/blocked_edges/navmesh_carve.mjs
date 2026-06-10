import earcut from "earcut";
import polygonClipping from "polygon-clipping";
import {PREPROCESS_CONFIG} from "../config.mjs";
import {createTriangleComponents} from "./navmesh_components.mjs";

const CARVE_CONFIG = PREPROCESS_CONFIG.blockedEdges.navmeshCarve;
const SURFACE_VERTICAL_OFFSET = PREPROCESS_CONFIG.blockedEdges.verticalOffset;
const MAX_OUTPUT_TRIANGLE_RATIO = 5;
const EPSILON = 1e-8;

if (!Number.isFinite(CARVE_CONFIG?.verticalDistance)) {
	throw new Error("Missing blocked edge navmesh carve config: verticalDistance");
}

if (!Number.isFinite(CARVE_CONFIG?.minimumFragmentArea)) {
	throw new Error("Missing blocked edge navmesh carve config: minimumFragmentArea");
}

function bounds2d(points) {
	const bounds = {
		minX: Infinity,
		minY: Infinity,
		maxX: -Infinity,
		maxY: -Infinity,
	};

	for (const point of points) {
		bounds.minX = Math.min(bounds.minX, point[0]);
		bounds.minY = Math.min(bounds.minY, point[1]);
		bounds.maxX = Math.max(bounds.maxX, point[0]);
		bounds.maxY = Math.max(bounds.maxY, point[1]);
	}

	return bounds;
}

function boundsOverlap(left, right) {
	return left.minX <= right.maxX
		&& right.minX <= left.maxX
		&& left.minY <= right.maxY
		&& right.minY <= left.maxY;
}

function signedArea2d(points) {
	let area = 0;

	for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
		area += points[previous][0] * points[index][1] - points[index][0] * points[previous][1];
	}

	return area / 2;
}

function polygonArea2d(points) {
	return Math.abs(signedArea2d(points));
}

function triangleArea2dFromPoints(points) {
	return Math.abs(
		(points[1][0] - points[0][0]) * (points[2][1] - points[0][1])
		- (points[1][1] - points[0][1]) * (points[2][0] - points[0][0])
	) / 2;
}

function closeRing(points) {
	const result = points.map((point) => [point[0], point[1]]);
	const first = result[0];
	const last = result[result.length - 1];

	if (first[0] !== last[0] || first[1] !== last[1]) {
		result.push([...first]);
	}

	return result;
}

function openRing(ring) {
	const result = ring.map((point) => [point[0], point[1]]);
	const first = result[0];
	const last = result[result.length - 1];

	if (result.length > 1 && first[0] === last[0] && first[1] === last[1]) {
		result.pop();
	}

	return result;
}

function samePoint(left, right) {
	return Math.abs(left[0] - right[0]) <= EPSILON
		&& Math.abs(left[1] - right[1]) <= EPSILON;
}

function isCollinear(previous, current, next) {
	const cross = (current[0] - previous[0]) * (next[1] - current[1])
		- (current[1] - previous[1]) * (next[0] - current[0]);

	return Math.abs(cross) <= EPSILON;
}

function removeRepeatedPoints(points) {
	const result = [];

	for (const point of points) {
		const previous = result[result.length - 1];

		if (!previous || !samePoint(previous, point)) {
			result.push(point);
		}
	}

	if (result.length > 1 && samePoint(result[0], result[result.length - 1])) {
		result.pop();
	}

	return result;
}

function removeCollinearPoints(points) {
	let result = points;
	let changed = true;

	while (changed && result.length > 3) {
		changed = false;
		result = result.filter((point, index) => {
			const previous = result[(index + result.length - 1) % result.length];
			const next = result[(index + 1) % result.length];
			const keep = !isCollinear(previous, point, next);

			if (!keep) {
				changed = true;
			}

			return keep;
		});
	}

	return result;
}

function cleanRing(ring) {
	return removeCollinearPoints(removeRepeatedPoints(openRing(ring)));
}

function cleanPolygonRings(rings) {
	return rings
		.map(cleanRing)
		.filter((ring) => ring.length >= 3 && polygonArea2d(ring) > EPSILON);
}

function toClippingPolygon(points) {
	return [[closeRing(points)]];
}

function ringsToClippingPolygon(rings) {
	return [rings.map(closeRing)];
}

function pointSide(point, start, end) {
	return (end[0] - start[0]) * (point[1] - start[1])
		- (end[1] - start[1]) * (point[0] - start[0]);
}

function lineIntersection(start, end, clipStart, clipEnd) {
	const direction = [end[0] - start[0], end[1] - start[1]];
	const clipDirection = [clipEnd[0] - clipStart[0], clipEnd[1] - clipStart[1]];
	const denominator = direction[0] * clipDirection[1] - direction[1] * clipDirection[0];

	if (Math.abs(denominator) <= EPSILON) {
		return end;
	}

	const relative = [clipStart[0] - start[0], clipStart[1] - start[1]];
	const amount = (relative[0] * clipDirection[1] - relative[1] * clipDirection[0]) / denominator;

	return [
		start[0] + direction[0] * amount,
		start[1] + direction[1] * amount,
	];
}

function clipPolygonByLine(points, clipStart, clipEnd, orientation) {
	const output = [];

	for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
		const currentPoint = points[index];
		const previousPoint = points[previous];
		const currentInside = pointSide(currentPoint, clipStart, clipEnd) * orientation >= -EPSILON;
		const previousInside = pointSide(previousPoint, clipStart, clipEnd) * orientation >= -EPSILON;

		if (currentInside !== previousInside) {
			output.push(lineIntersection(previousPoint, currentPoint, clipStart, clipEnd));
		}

		if (currentInside) {
			output.push(currentPoint);
		}
	}

	return output;
}

function polygonClippedByTriangleArea(points, triangle) {
	let clipped = points.map((point) => [point[0], point[1]]);
	const triangle2d = triangle.map((point) => [point[0], point[1]]);
	const orientation = signedArea2d(triangle2d) >= 0 ? 1 : -1;

	for (let index = 0; index < triangle2d.length && clipped.length >= 3; index++) {
		clipped = clipPolygonByLine(
			clipped,
			triangle2d[index],
			triangle2d[(index + 1) % triangle2d.length],
			orientation,
		);
	}

	if (clipped.length < 3) {
		return 0;
	}

	return polygonArea2d(clipped);
}

function trianglePlaneZ(triangle) {
	const [a, b, c] = triangle;
	const ux = b[0] - a[0];
	const uy = b[1] - a[1];
	const uz = b[2] - a[2];
	const vx = c[0] - a[0];
	const vy = c[1] - a[1];
	const vz = c[2] - a[2];
	const normal = [
		uy * vz - uz * vy,
		uz * vx - ux * vz,
		ux * vy - uy * vx,
	];

	if (Math.abs(normal[2]) <= EPSILON) {
		return null;
	}

	return (x, y) => a[2] - (normal[0] * (x - a[0]) + normal[1] * (y - a[1])) / normal[2];
}

function triangleNormal(triangle) {
	const [a, b, c] = triangle;
	const ux = b[0] - a[0];
	const uy = b[1] - a[1];
	const uz = b[2] - a[2];
	const vx = c[0] - a[0];
	const vy = c[1] - a[1];
	const vz = c[2] - a[2];
	const normal = [
		uy * vz - uz * vy,
		uz * vx - ux * vz,
		ux * vy - uy * vx,
	];
	const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;

	return [
		normal[0] / length,
		normal[1] / length,
		normal[2] / length,
	];
}

function triangleZRange(triangle) {
	return {
		minZ: Math.min(triangle[0][2], triangle[1][2], triangle[2][2]),
		maxZ: Math.max(triangle[0][2], triangle[1][2], triangle[2][2]),
	};
}

function blockerAppliesToTriangle(blocker, triangle, triangleBounds) {
	const range = triangleZRange(triangle);

	return blocker.z >= range.minZ - CARVE_CONFIG.verticalDistance
		&& blocker.z <= range.maxZ + CARVE_CONFIG.verticalDistance
		&& boundsOverlap(triangleBounds, blocker.bounds)
		&& polygonClippedByTriangleArea(blocker.points, triangle) > EPSILON;
}

function prepareBlockers(polygons) {
	return (polygons ?? [])
		.filter((polygon) => polygon.points.length >= 3 && polygonArea2d(polygon.points) > EPSILON)
		.map((polygon) => ({
			...polygon,
			bounds: bounds2d(polygon.points),
			clippingPolygon: toClippingPolygon(polygon.points),
		}));
}

function geometryIsEmpty(geometry) {
	return !geometry || geometry.length === 0;
}

function unionGeometries(geometries, triangleIndex) {
	if (geometries.length === 0) {
		return [];
	}

	if (geometries.length === 1) {
		return geometries[0];
	}

	try {
		return polygonClipping.union(...geometries);
	} catch (error) {
		error.message = `Unable to union blocked footprints for navmesh triangle ${triangleIndex}: ${error.message}`;
		throw error;
	}
}

function flattenPolygonForEarcut(rings) {
	const vertices = [];
	const holes = [];
	const vertexSources = [];

	for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
		const ring = cleanRing(rings[ringIndex]);

		if (ring.length < 3 || polygonArea2d(ring) <= EPSILON) {
			continue;
		}

		if (ringIndex > 0) {
			holes.push(vertices.length / 2);
		}

		for (const point of ring) {
			vertices.push(point[0], point[1]);
			vertexSources.push({ringIndex});
		}
	}

	return {vertices, holes, vertexSources};
}

function earcutTriangles(rings) {
	const {vertices, holes} = flattenPolygonForEarcut(rings);

	if (vertices.length < 6) {
		return [];
	}

	const indices = earcut(vertices, holes, 2);
	const triangles = [];

	for (let index = 0; index < indices.length; index += 3) {
		triangles.push(indices.slice(index, index + 3).map((vertexIndex) => [
			vertices[vertexIndex * 2],
			vertices[vertexIndex * 2 + 1],
		]));
	}

	return triangles.filter((triangle) => polygonArea2d(triangle) > EPSILON);
}

function addVertex(vertices, vertexIndexes, point) {
	const key = point.map((value) => value.toFixed(6)).join(",");
	const existing = vertexIndexes.get(key);

	if (existing) {
		return existing;
	}

	vertices.push(point);
	vertexIndexes.set(key, vertices.length);

	return vertices.length;
}

function addClippedPolygon(rings, zAt, output, source) {
	const {vertices: flatVertices, holes, vertexSources} = flattenPolygonForEarcut(rings);

	if (flatVertices.length < 6) {
		return;
	}

	const indices = earcut(flatVertices, holes, 2);

	for (let index = 0; index < indices.length; index += 3) {
		const points = [];

		for (let offset = 0; offset < 3; offset++) {
			const vertexIndex = indices[index + offset] * 2;
			const source = vertexSources[indices[index + offset]];
			const x = flatVertices[vertexIndex];
			const y = flatVertices[vertexIndex + 1];
			let z;

			try {
				z = zAt(x, y);
			} catch (error) {
				error.message = `${error.message}. Earcut ring index: ${source.ringIndex}`;
				throw error;
			}

			points.push([x, y, z]);
		}

		addTriangle(points, output, source);
	}
}

function validDifferencePiece(points) {
	const cleaned = cleanRing(points);

	return cleaned.length >= 3 && polygonArea2d(cleaned) > EPSILON
		? cleaned
		: null;
}

function splitOutsideConvexCutter(subject, cutter) {
	const orientation = signedArea2d(cutter) >= 0 ? 1 : -1;
	const result = [];
	let insidePieces = [subject];

	for (let index = 0; index < cutter.length; index++) {
		const start = cutter[index];
		const end = cutter[(index + 1) % cutter.length];
		const nextInsidePieces = [];

		for (const piece of insidePieces) {
			const outside = validDifferencePiece(clipPolygonByLine(piece, start, end, -orientation));
			const inside = validDifferencePiece(clipPolygonByLine(piece, start, end, orientation));

			if (outside) {
				result.push(outside);
			}

			if (inside) {
				nextInsidePieces.push(inside);
			}
		}

		insidePieces = nextInsidePieces;

		if (insidePieces.length === 0) {
			break;
		}
	}

	return result;
}

function subtractConvexCutter(subjectPieces, cutter) {
	const result = [];

	for (const subject of subjectPieces) {
		result.push(...splitOutsideConvexCutter(subject, cutter));
	}

	return result;
}

function subtractFootprintsFromTriangle(triangle, footprints) {
	let pieces = [triangle.map((point) => [point[0], point[1]])];

	for (const footprint of footprints) {
		for (const cutter of earcutTriangles(footprint.rings)) {
			pieces = subtractConvexCutter(pieces, cutter);

			if (pieces.length === 0) {
				return pieces;
			}
		}
	}

	return pieces;
}

function pushMeshVertex(mesh, position, normal) {
	mesh.positions.push(position[0], position[1], position[2]);
	mesh.normals.push(normal[0], normal[1], normal[2]);

	return mesh.positions.length / 3 - 1;
}

function addSurfacePolygon(mesh, rings, zAt, normal) {
	const {vertices: flatVertices, holes} = flattenPolygonForEarcut(rings);

	if (flatVertices.length < 6) {
		return false;
	}

	const indices = earcut(flatVertices, holes, 2);

	for (let index = 0; index < indices.length; index += 3) {
		const triangle = [];

		for (let offset = 0; offset < 3; offset++) {
			const vertexIndex = indices[index + offset] * 2;
			const x = flatVertices[vertexIndex];
			const y = flatVertices[vertexIndex + 1];

			triangle.push(pushMeshVertex(mesh, [x, y, zAt(x, y) + SURFACE_VERTICAL_OFFSET], normal));
		}

		mesh.indices.push(...triangle);
	}

	return true;
}

function addTriangle(points, output, source) {
	if (triangleArea2dFromPoints(points) <= EPSILON) {
		output.skippedDegenerateTriangles++;

		return;
	}

	output.triangles.push(points.map((point) => addVertex(output.vertices, output.vertexIndexes, point)));
	output.sources.push(source);
}

function trianglePositions(navmesh, triangle) {
	return triangle.slice(0, 3).map((index) => navmesh.vertices[index - 1]);
}

function triangleFootprints(navmesh, triangleIndex, blockers) {
	const triangle = navmesh.triangles[triangleIndex];
	const points = trianglePositions(navmesh, triangle);
	const triangleBounds = bounds2d(points);
	const subject = toClippingPolygon(points);
	const geometries = [];

	for (const blocker of blockers) {
		if (!blockerAppliesToTriangle(blocker, points, triangleBounds)) {
			continue;
		}

		const overlap = polygonClipping.intersection(subject, blocker.clippingPolygon);

		if (!geometryIsEmpty(overlap)) {
			geometries.push(overlap);
		}
	}

	return {
		points,
		geometry: unionGeometries(geometries, triangleIndex),
	};
}

function createFootprint(triangleIndex, rings) {
	const cleanRings = cleanPolygonRings(rings);

	if (cleanRings.length === 0) {
		return null;
	}

	return {
		triangleIndex,
		rings: cleanRings,
		clippingPolygon: ringsToClippingPolygon(cleanRings),
	};
}

function footprintsByTriangle(footprints) {
	const result = new Map();

	for (const footprint of footprints ?? []) {
		const list = result.get(footprint.triangleIndex) ?? [];

		list.push(footprint);
		result.set(footprint.triangleIndex, list);
	}

	return result;
}

function carveTriangle(triangleIndex, points, footprints, output) {
	if (!footprints?.length) {
		addTriangle(points, output, "original");

		return false;
	}

	const zAt = trianglePlaneZ(points);

	if (!zAt) {
		addTriangle(points, output, "original");

		return false;
	}

	const pieces = subtractFootprintsFromTriangle(points, footprints);

	if (pieces.length === 0) {
		return true;
	}

	for (const piece of pieces) {
		addClippedPolygon([piece], zAt, output, "carved");
	}

	return true;
}

function assertOutputSize(inputTriangleCount, outputTriangleCount) {
	if (outputTriangleCount > inputTriangleCount * MAX_OUTPUT_TRIANGLE_RATIO) {
		throw new Error(
			`Carved navmesh generated too many triangles: ${outputTriangleCount} from ${inputTriangleCount}. `
			+ `The limit is ${MAX_OUTPUT_TRIANGLE_RATIO}x.`,
		);
	}
}

function compactOutput(output, keptTriangleIndexes) {
	const vertices = [];
	const vertexIndexes = new Map();
	const triangles = [];
	const sources = [];

	for (const triangleIndex of keptTriangleIndexes) {
		const triangle = output.triangles[triangleIndex];

		triangles.push(triangle.map((oldIndex) => {
			const point = output.vertices[oldIndex - 1];
			const key = point.map((value) => value.toFixed(6)).join(",");
			const existing = vertexIndexes.get(key);

			if (existing) {
				return existing;
			}

			vertices.push(point);
			vertexIndexes.set(key, vertices.length);

			return vertices.length;
		}));
		sources.push(output.sources[triangleIndex]);
	}

	return {
		...output,
		vertices,
		vertexIndexes,
		triangles,
		sources,
	};
}

function removeSmallFragments(output) {
	const minimumArea = CARVE_CONFIG.minimumFragmentArea;

	if (minimumArea <= 0 || output.triangles.length === 0) {
		return {
			output,
			stats: {
				removedFragmentComponents: 0,
				removedFragmentTriangles: 0,
				removedFragmentArea: 0,
			},
		};
	}

	const removedTriangleIndexes = new Set();
	let removedComponents = 0;
	let removedArea = 0;

	for (const component of createTriangleComponents(output)) {
		if (component.hasOriginalSurface || component.area >= minimumArea) {
			continue;
		}

		removedComponents++;
		removedArea += component.area;

		for (const triangleIndex of component.triangles) {
			removedTriangleIndexes.add(triangleIndex);
		}
	}

	if (removedTriangleIndexes.size === 0) {
		return {
			output,
			stats: {
				removedFragmentComponents: 0,
				removedFragmentTriangles: 0,
				removedFragmentArea: 0,
			},
		};
	}

	const keptTriangleIndexes = output.triangles
		.map((_, index) => index)
		.filter((index) => !removedTriangleIndexes.has(index));

	return {
		output: compactOutput(output, keptTriangleIndexes),
		stats: {
			removedFragmentComponents: removedComponents,
			removedFragmentTriangles: removedTriangleIndexes.size,
			removedFragmentArea: removedArea,
		},
	};
}

export function createBlockedFootprints(navmesh, polygons) {
	const blockers = prepareBlockers(polygons);
	const footprints = [];
	const mesh = {
		positions: [],
		normals: [],
		indices: [],
	};

	if (blockers.length === 0) {
		return {
			footprints,
			mesh: null,
			stats: {
				sourcePolygons: 0,
				footprints: 0,
				triangles: 0,
			},
		};
	}

	for (let triangleIndex = 0; triangleIndex < navmesh.triangles.length; triangleIndex++) {
		const {points, geometry} = triangleFootprints(navmesh, triangleIndex, blockers);

		if (geometryIsEmpty(geometry)) {
			continue;
		}

		const zAt = trianglePlaneZ(points);

		if (!zAt) {
			continue;
		}

		const normal = triangleNormal(points);

		for (const polygon of geometry) {
			const footprint = createFootprint(triangleIndex, polygon);

			if (!footprint || !addSurfacePolygon(mesh, footprint.rings, zAt, normal)) {
				continue;
			}

			footprints.push(footprint);
		}
	}

	return {
		footprints,
		mesh: mesh.indices.length > 0 ? mesh : null,
		stats: {
			sourcePolygons: blockers.length,
			footprints: footprints.length,
			triangles: mesh.indices.length / 3,
		},
	};
}

export function carveNavmesh(navmesh, footprints) {
	const byTriangle = footprintsByTriangle(footprints);

	if (byTriangle.size === 0) {
		return {
			navmesh,
			stats: {
				inputTriangles: navmesh.triangles.length,
				outputTriangles: navmesh.triangles.length,
				carvedTriangles: 0,
				blockerFootprints: 0,
			},
		};
	}

	const output = {
		vertices: [],
		vertexIndexes: new Map(),
		triangles: [],
		sources: [],
		skippedDegenerateTriangles: 0,
	};
	let carvedTriangles = 0;

	for (const [triangleIndex, triangle] of navmesh.triangles.entries()) {
		const points = trianglePositions(navmesh, triangle);
		let carved;

		try {
			carved = carveTriangle(triangleIndex, points, byTriangle.get(triangleIndex), output);
		} catch (error) {
			error.message = `Unable to carve navmesh triangle ${triangleIndex}: ${error.message}`;
			throw error;
		}

		if (carved) {
			carvedTriangles++;
		}
	}

	const filtered = removeSmallFragments(output);
	const finalOutput = filtered.output;

	assertOutputSize(navmesh.triangles.length, finalOutput.triangles.length);

	return {
		navmesh: {
			...navmesh,
			vertices: finalOutput.vertices,
			triangles: finalOutput.triangles,
			stats: {
				...navmesh.stats,
				triangles: finalOutput.triangles.length,
			},
			bounds: navmesh.bounds,
		},
		stats: {
			inputTriangles: navmesh.triangles.length,
			outputTriangles: finalOutput.triangles.length,
			carvedTriangles,
			blockerFootprints: footprints.length,
			skippedDegenerateTriangles: output.skippedDegenerateTriangles,
			...filtered.stats,
		},
	};
}
