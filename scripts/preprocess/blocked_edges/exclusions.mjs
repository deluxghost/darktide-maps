import {add, pointInPolygon2d, scale, subtract} from "./geometry.mjs";

const EPSILON = 1e-8;

function dot(left, right) {
	return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function distanceSquared(left, right) {
	return (left[0] - right[0]) ** 2
		+ (left[1] - right[1]) ** 2
		+ (left[2] - right[2]) ** 2;
}

function closestPointOnTriangle(point, a, b, c) {
	const ab = subtract(b, a);
	const ac = subtract(c, a);
	const ap = subtract(point, a);
	const d1 = dot(ab, ap);
	const d2 = dot(ac, ap);

	if (d1 <= 0 && d2 <= 0) {
		return a;
	}

	const bp = subtract(point, b);
	const d3 = dot(ab, bp);
	const d4 = dot(ac, bp);

	if (d3 >= 0 && d4 <= d3) {
		return b;
	}

	const vc = d1 * d4 - d3 * d2;

	if (vc <= 0 && d1 >= 0 && d3 <= 0) {
		return add(a, scale(ab, d1 / (d1 - d3)));
	}

	const cp = subtract(point, c);
	const d5 = dot(ab, cp);
	const d6 = dot(ac, cp);

	if (d6 >= 0 && d5 <= d6) {
		return c;
	}

	const vb = d5 * d2 - d1 * d6;

	if (vb <= 0 && d2 >= 0 && d6 <= 0) {
		return add(a, scale(ac, d2 / (d2 - d6)));
	}

	const va = d3 * d6 - d5 * d4;

	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		return add(b, scale(subtract(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
	}

	const denominator = 1 / (va + vb + vc);
	const v = vb * denominator;
	const w = vc * denominator;

	return add(a, add(scale(ab, v), scale(ac, w)));
}

function trianglePositions(navmesh, triangle) {
	return triangle.slice(0, 3).map((index) => navmesh.vertices[index - 1]);
}

function nearestNavmeshSurfacePoint(navmesh, point) {
	let best = null;

	for (const triangle of navmesh.triangles) {
		const [a, b, c] = trianglePositions(navmesh, triangle);
		const candidate = closestPointOnTriangle(point, a, b, c);
		const distance = distanceSquared(point, candidate);

		if (!best || distance < best.distance) {
			best = {point: candidate, distance};
		}
	}

	if (!best) {
		throw new Error("Unable to map blocked edge exclude point to navmesh: navmesh has no triangles.");
	}

	return best.point;
}

function validateExcludePoint(missionId, point) {
	if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
		throw new Error(`Invalid blocked edge exclude point in ${missionId}: ${JSON.stringify(point)}`);
	}
}

function findExcludedPolygonIndex(missionId, polygons, point, options) {
	const snapped = nearestNavmeshSurfacePoint(options.navmesh, point);
	let best = null;

	for (const [index, polygon] of polygons.entries()) {
		const verticalDistance = Math.abs(snapped[2] - polygon.z);

		if (!pointInPolygon2d(snapped, polygon.points) || verticalDistance > options.verticalTolerance) {
			continue;
		}

		if (!best || verticalDistance < best.verticalDistance) {
			best = {index, verticalDistance};
		}
	}

	if (!best) {
		throw new Error(`Blocked edge exclude point did not match any polygon in ${missionId}: ${JSON.stringify(point)}`);
	}

	return best.index;
}

export function filterExcludedPolygons(missionId, navmesh, polygons, excludePoints, options) {
	if (!Array.isArray(excludePoints)) {
		throw new Error(`Blocked edge exclude points in ${missionId} must be an array.`);
	}

	if (!Number.isFinite(options.verticalTolerance)) {
		throw new Error("Blocked edge exclude vertical tolerance must be a finite number.");
	}

	if (excludePoints.length === 0) {
		return {
			polygons,
			excludedPolygons: 0,
			excludePoints: 0,
		};
	}

	const excluded = new Set();
	const excludeOptions = {
		...options,
		navmesh,
	};

	for (const point of excludePoints) {
		validateExcludePoint(missionId, point);
		excluded.add(findExcludedPolygonIndex(missionId, polygons, point, excludeOptions));
	}

	return {
		polygons: polygons.filter((_, index) => !excluded.has(index)),
		excludedPolygons: excluded.size,
		excludePoints: excludePoints.length,
	};
}
