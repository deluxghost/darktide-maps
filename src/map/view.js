import { OrbitViewport } from "@deck.gl/core";
import { APP_CONFIG } from "../config.js";

const RUNTIME = APP_CONFIG.runtime;

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function boundsFromPositions(positions) {
	if (!positions?.length) {
		return null;
	}

	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];

	for (let index = 0; index < positions.length; index += 3) {
		for (let axis = 0; axis < 3; axis++) {
			const value = positions[index + axis];

			min[axis] = Math.min(min[axis], value);
			max[axis] = Math.max(max[axis], value);
		}
	}

	return {min, max};
}

function rotatePoint2D(point, rotationDegrees) {
	const radians = rotationDegrees * Math.PI / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);

	return [
		point[0] * cos - point[1] * sin,
		point[0] * sin + point[1] * cos,
	];
}

function projectionPoints(map, bounds) {
	const hull = map.view?.projectedHull;

	if (!hull?.length) {
		throw new Error(`Map ${map.id} is missing view projected hull.`);
	}

	const points = [];

	for (const point of hull) {
		points.push([point[0], point[1], bounds.min[2]]);
		points.push([point[0], point[1], bounds.max[2]]);
	}

	return points;
}

function createOrbitViewport(viewport, target, rotationOrbit, zoom = 0) {
	return new OrbitViewport({
		width: viewport.width,
		height: viewport.height,
		target,
		zoom,
		rotationOrbit,
		rotationX: RUNTIME.view.initialRotationX,
		orbitAxis: RUNTIME.controls.orbitAxis,
		orthographic: RUNTIME.controls.orthographic,
		near: RUNTIME.view.near,
		far: RUNTIME.view.far,
	});
}

export function createOrbitViewportForViewState(viewport, viewState) {
	return new OrbitViewport({
		width: viewport.width,
		height: viewport.height,
		target: viewState.target,
		zoom: viewState.zoom,
		rotationOrbit: viewState.rotationOrbit,
		rotationX: viewState.rotationX,
		orbitAxis: RUNTIME.controls.orbitAxis,
		orthographic: RUNTIME.controls.orthographic,
		near: RUNTIME.view.near,
		far: RUNTIME.view.far,
	});
}

export function viewportCenter(viewport) {
	return [
		viewport.width / 2,
		viewport.height / 2,
	];
}

function screenBounds(points, orbitViewport) {
	const min = [Infinity, Infinity];
	const max = [-Infinity, -Infinity];

	for (const point of points) {
		const projected = orbitViewport.project(point);

		for (let axis = 0; axis < 2; axis++) {
			min[axis] = Math.min(min[axis], projected[axis]);
			max[axis] = Math.max(max[axis], projected[axis]);
		}
	}

	return {
		min,
		max,
		width: Math.max(max[0] - min[0], RUNTIME.view.minWorldSize),
		height: Math.max(max[1] - min[1], RUNTIME.view.minWorldSize),
	};
}

function projectionTarget(bounds) {
	return [0, 0, (bounds.min[2] + bounds.max[2]) / 2];
}

function fitScale(map, bounds, viewport, rotationOrbit) {
	const orbitViewport = createOrbitViewport(viewport, projectionTarget(bounds), rotationOrbit);
	const boundsOnScreen = screenBounds(projectionPoints(map, bounds), orbitViewport);

	return Math.min(viewport.width / boundsOnScreen.width, viewport.height / boundsOnScreen.height);
}

function areaScale(map, viewport) {
	const area = map.view?.projectedArea;

	if (!Number.isFinite(area) || area <= 0) {
		throw new Error(`Map ${map.id} is missing view projected area.`);
	}

	return Math.sqrt(viewport.width * viewport.height * RUNTIME.view.initialAreaCoverage / area);
}

function initialZoom(map, bounds, viewport, rotationOrbit) {
	const area = areaScale(map, viewport);
	const fit = fitScale(map, bounds, viewport, rotationOrbit) * RUNTIME.view.initialBoundsCoverage;

	return Math.log2(Math.min(area, fit));
}

function projectedTarget(map, bounds, viewport, rotationOrbit, zoom) {
	const initialTarget = projectionTarget(bounds);
	const orbitViewport = createOrbitViewport(viewport, initialTarget, rotationOrbit, zoom);
	const boundsOnScreen = screenBounds(projectionPoints(map, bounds), orbitViewport);
	const projectedCenter = [
		(boundsOnScreen.min[0] + boundsOnScreen.max[0]) / 2,
		(boundsOnScreen.min[1] + boundsOnScreen.max[1]) / 2,
	];
	const centerWorld = orbitViewport.unproject(projectedCenter);

	return orbitViewport.panByPosition(centerWorld, viewportCenter(viewport)).target;
}

function principalAxis(positions) {
	if (!positions?.length) {
		return null;
	}

	let count = 0;
	let meanX = 0;
	let meanY = 0;

	for (let index = 0; index < positions.length; index += 3) {
		meanX += positions[index];
		meanY += positions[index + 1];
		count++;
	}

	meanX /= count;
	meanY /= count;

	let varianceX = 0;
	let varianceY = 0;
	let covariance = 0;

	for (let index = 0; index < positions.length; index += 3) {
		const x = positions[index] - meanX;
		const y = positions[index + 1] - meanY;

		varianceX += x * x;
		varianceY += y * y;
		covariance += x * y;
	}

	const trace = varianceX + varianceY;
	const delta = Math.hypot(varianceX - varianceY, 2 * covariance);
	const major = (trace + delta) / 2;
	const minor = (trace - delta) / 2;

	if (minor <= 0 || major / minor < RUNTIME.view.initialMainAxisMinRatio) {
		return null;
	}

	return Math.atan2(2 * covariance, varianceX - varianceY) / 2 * 180 / Math.PI;
}

function pathPreferenceScore(mainPath, rotationOrbit) {
	if (!mainPath?.start || !mainPath?.end) {
		return 0;
	}

	const start = rotatePoint2D(mainPath.start, rotationOrbit);
	const end = rotatePoint2D(mainPath.end, rotationOrbit);
	const dx = end[0] - start[0];
	const dy = end[1] - start[1];

	return (dx >= 0 ? 2 : 0) + (dy >= 0 ? 1 : 0);
}

function candidateRotations(axis) {
	const angle = RUNTIME.view.initialMainAxisScreenAngle;
	const primary = angle - axis;
	const secondary = -angle - axis;

	return [
		normalizeRotation(primary),
		normalizeRotation(primary + 180),
		normalizeRotation(secondary),
		normalizeRotation(secondary + 180),
	];
}

function preferredRotationOrbit(map, axis, viewport) {
	const candidates = candidateRotations(axis).map((rotationOrbit) => ({
		rotationOrbit,
		scale: fitScale(map, map.bounds, viewport, rotationOrbit),
		pathScore: pathPreferenceScore(map.landmarks?.mainPath, rotationOrbit),
	}));
	const bestScale = Math.max(...candidates.map((candidate) => candidate.scale));
	const minScale = bestScale * RUNTIME.view.initialPathPreferenceMinScaleRatio;
	const acceptable = candidates.filter((candidate) => candidate.scale >= minScale);

	acceptable.sort((left, right) => (
		right.pathScore - left.pathScore
		|| right.scale - left.scale
		|| Math.abs(left.rotationOrbit) - Math.abs(right.rotationOrbit)
	));

	return acceptable[0].rotationOrbit;
}

function initialRotationOrbit(map, positions, viewport) {
	const override = RUNTIME.view.initialRotationOrbitByMapId[map.id];

	if (Number.isFinite(override)) {
		return override;
	}

	const axis = principalAxis(positions);

	if (axis === null) {
		return 0;
	}

	return preferredRotationOrbit(map, axis, viewport);
}

function normalizeRotation(degrees) {
	return ((degrees + 180) % 360 + 360) % 360 - 180;
}

export function constrainedViewState(map, positions, viewport) {
	const fitBounds = boundsFromPositions(positions) ?? map.bounds;
	const rotationOrbit = initialRotationOrbit(map, positions, viewport);
	const zoom = clamp(
		initialZoom(map, fitBounds, viewport, rotationOrbit),
		RUNTIME.view.minZoom,
		RUNTIME.view.maxZoom,
	);

	return {
		target: projectedTarget(map, fitBounds, viewport, rotationOrbit, zoom),
		rotationOrbit,
		rotationX: RUNTIME.view.initialRotationX,
		minRotationX: RUNTIME.view.minRotationX,
		maxRotationX: RUNTIME.view.maxRotationX,
		minZoom: RUNTIME.view.minZoom,
		maxZoom: RUNTIME.view.maxZoom,
		zoom,
	};
}
