import { COORDINATE_SYSTEM, Deck, OrbitView, OrbitViewport } from "@deck.gl/core";
import { IconLayer, PathLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { APP_CONFIG } from "./config.js";
import { pinIconForCategory } from "./icons.js";

const RUNTIME = APP_CONFIG.runtime;
const VISUAL = RUNTIME.visual;
const OVERLAY_LINE_PARAMETERS = {
	blend: false,
	depthCompare: "less-equal",
	depthMask: false,
	depthTest: true,
	depthWriteEnabled: false,
	depthBias: VISUAL.navmesh.boundaryDepthBias,
	depthBiasSlopeScale: VISUAL.navmesh.boundaryDepthBiasSlopeScale,
};

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function viewDepth(pin, viewport) {
	const position = pin.position;
	const matrix = viewport.viewMatrix;

	return matrix[2] * position[0] + matrix[6] * position[1] + matrix[10] * position[2] + matrix[14];
}

function sortedPins(pins, visibleCategories, viewport) {
	const visiblePins = pins.filter((pin) => visibleCategories.has(pin.category) || pin.markerType === "auxiliary_pin");

	if (!viewport) {
		return visiblePins;
	}

	return visiblePins
		.map((pin, index) => ({
			pin,
			index,
			depth: viewDepth(pin, viewport),
		}))
		.sort((left, right) => left.depth - right.depth || left.index - right.index)
		.map((entry) => entry.pin);
}

function auxiliaryPinsForMarker(marker) {
	return (marker?.auxiliaryMarkers ?? []).map((auxiliary) => ({
		...auxiliary,
		category: marker.category,
		markerType: "auxiliary_pin",
		parentMarker: marker,
	}));
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

function viewportCenter(viewport) {
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

function constrainedViewState(map, positions, viewport) {
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

export function createMapRenderer(mapElement, onError) {
	let deckInstance;
	let currentState;
	let viewChangeFrame = 0;

	function isCtrlClick(event) {
		return Boolean(event?.srcEvent?.ctrlKey);
	}

	function requestViewChange() {
		if (viewChangeFrame) {
			return;
		}

		viewChangeFrame = requestAnimationFrame(() => {
			viewChangeFrame = 0;
			currentState?.onViewChange?.();
		});
	}

	function requestViewChangeAfterResize() {
		requestAnimationFrame(() => {
			requestViewChange();
		});
	}

	function setViewState(viewState) {
		if (!currentState || !deckInstance) {
			return;
		}

		currentState.viewState = viewState;
		deckInstance.setProps({viewState});
	}

	function createLayers() {
		if (!currentState) {
			return [];
		}

		const { map, mesh, boundaryPaths, mainPathMeshes, mainPathVisible, markerPins, auxiliaryMarkerOwner, visiblePinCategories } = currentState;
		const viewport = deckInstance?.getViewports()[0];
		const auxiliaryPins = auxiliaryPinsForMarker(auxiliaryMarkerOwner);
		const visiblePins = sortedPins(
			auxiliaryPins.length ? [...markerPins, ...auxiliaryPins] : markerPins,
			visiblePinCategories,
			viewport,
		);
		const layers = [
			new SimpleMeshLayer({
				id: `navmesh-surface-${map.id}`,
				data: [{}],
				mesh,
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				getPosition: [0, 0, 0],
				getColor: [255, 255, 255, 255],
				wireframe: false,
				pickable: Boolean(currentState.onMapCoordinatePick),
				material: VISUAL.lighting.navmeshMaterial,
				getPolygonOffset: () => [0, 0],
				parameters: RUNTIME.layers.opaqueMeshParameters,
			}),
		];

		layers.push(new PathLayer({
			id: `navmesh-boundaries-${map.id}`,
			data: boundaryPaths,
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			getPath: (boundary) => boundary.path,
			getColor: VISUAL.navmesh.boundaryColor,
			getWidth: VISUAL.navmesh.boundaryWidth,
			widthUnits: "common",
			jointRounded: true,
			capRounded: true,
			getPolygonOffset: () => [0, 0],
			parameters: OVERLAY_LINE_PARAMETERS,
		}));

		if (mainPathMeshes && mainPathVisible) {
			for (const [part, partMesh] of Object.entries(mainPathMeshes)) {
				layers.push(new SimpleMeshLayer({
					id: `landmark-main-path-${part}-${map.id}`,
					data: [{}],
					mesh: partMesh,
					coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
					getPosition: [0, 0, 0],
					getColor: VISUAL.mainPath[`${part}Color`],
					wireframe: false,
					material: VISUAL.lighting.mainPathMaterial,
					getPolygonOffset: () => [0, 0],
					parameters: RUNTIME.layers.opaqueMeshParameters,
				}));
			}
		}

		layers.push(new IconLayer({
			id: `pin-markers-${map.id}`,
			data: visiblePins,
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			getPosition: (pin) => pin.position,
			getIcon: (pin) => pinIconForCategory(pin.category, {
				centerCircle: pin.markerType !== "auxiliary_pin",
				iconWidth: pin.markerType === "auxiliary_pin" ? VISUAL.pins.iconWidth * VISUAL.auxiliaryLinks.auxiliaryPinScale : undefined,
				iconHeight: pin.markerType === "auxiliary_pin" ? VISUAL.pins.iconHeight * VISUAL.auxiliaryLinks.auxiliaryPinScale : undefined,
				strokeWidth: pin.markerType === "auxiliary_pin" ? VISUAL.auxiliaryLinks.auxiliaryPinStrokeWidth : undefined,
			}),
			getSize: (pin) => pin.markerType === "auxiliary_pin"
				? VISUAL.pins.iconHeight * VISUAL.auxiliaryLinks.auxiliaryPinScale
				: VISUAL.pins.iconHeight,
			sizeUnits: "pixels",
			billboard: true,
			pickable: true,
			alphaCutoff: 0.05,
			textureParameters: RUNTIME.layers.iconTextureParameters,
			parameters: RUNTIME.layers.screenMarkerParameters,
		}));

		return layers;
	}

	function updateLayers() {
		if (deckInstance) {
			deckInstance.setProps({ layers: createLayers() });
		}
	}

	function pickMapCoordinate(x, y) {
		if (!deckInstance || !currentState?.onMapCoordinatePick) {
			return;
		}

		const picked = deckInstance.pickObject({
			x,
			y,
			layerIds: [`navmesh-surface-${currentState.map.id}`],
			unproject3D: true,
		});

		currentState.onMapCoordinatePick(picked?.coordinate ?? null);
	}

	function render(map, mesh, boundaryPaths, mainPathMeshes, options) {
		const viewState = constrainedViewState(map, options.fitPositions, {
			width: mapElement.clientWidth || window.innerWidth,
			height: mapElement.clientHeight || window.innerHeight,
		});

		currentState = {
			map,
			mesh,
			boundaryPaths,
			mainPathMeshes,
			mainPathVisible: options.mainPathVisible,
			markerPins: options.markerPins,
			visiblePinCategories: new Set(options.visiblePinCategories),
			onMarkerClick: options.onMarkerClick,
			onMarkerHover: options.onMarkerHover,
			onMapCoordinatePick: options.onMapCoordinatePick,
			onViewChange: options.onViewChange,
			auxiliaryMarkerOwner: null,
			viewState,
		};

		if (deckInstance) {
			deckInstance.setProps({
				viewState,
				layers: createLayers(),
			});
			requestViewChange();

			return;
		}

		deckInstance = new Deck({
			parent: mapElement,
			views: new OrbitView({
				id: "map",
				near: RUNTIME.view.near,
				far: RUNTIME.view.far,
				controller: {
					dragMode: RUNTIME.controls.dragMode,
					touchRotate: RUNTIME.controls.touchRotate,
				},
				orbitAxis: RUNTIME.controls.orbitAxis,
				orthographic: RUNTIME.controls.orthographic,
			}),
			viewState,
			layers: createLayers(),
			onError,
			onViewStateChange: ({viewState: nextViewState}) => {
				const previousViewState = currentState.viewState;

				setViewState(nextViewState);

				if (
					nextViewState.rotationOrbit !== previousViewState.rotationOrbit
					|| nextViewState.rotationX !== previousViewState.rotationX
				) {
					requestAnimationFrame(updateLayers);
				}

				requestViewChange();
			},
			onClick: (info, event) => {
				if (isCtrlClick(event) && currentState.onMapCoordinatePick) {
					pickMapCoordinate(info.x, info.y);

					return true;
				}

				if (info.object?.markerType === "auxiliary_pin") {
					return true;
				}

				if (info.object?.markerType === "pin") {
					currentState.onMarkerClick(info.object, info.x, info.y);

					return true;
				}

				currentState.onMarkerClick(null);

				return false;
			},
			onHover: (info) => {
				const hoveredMarker = info.object?.markerType === "pin" || info.object?.markerType === "auxiliary_pin"
					? info.object
					: null;

				currentState.hoveredMarker = hoveredMarker;
				currentState.onMarkerHover?.(hoveredMarker);
			},
			getCursor: () => currentState?.hoveredMarker ? "pointer" : null,
		});

		requestAnimationFrame(updateLayers);
		requestViewChange();
	}

	function projectPosition(position) {
		const viewport = deckInstance?.getViewports()[0];

		if (!viewport) {
			return null;
		}

		const [x, y] = viewport.project(position);
		const bounds = mapElement.getBoundingClientRect();

		return {
			x: bounds.left + x,
			y: bounds.top + y,
		};
	}

	function setMainPathVisible(visible) {
		if (!currentState) {
			return;
		}

		currentState.mainPathVisible = visible;
		updateLayers();
	}

	function setPinCategoryVisible(category, visible) {
		if (!currentState) {
			return;
		}

		if (visible) {
			currentState.visiblePinCategories.add(category);
		} else {
			currentState.visiblePinCategories.delete(category);
		}

		updateLayers();
	}

	function setAuxiliaryMarkerOwner(marker) {
		if (!currentState || currentState.auxiliaryMarkerOwner === marker) {
			return;
		}

		currentState.auxiliaryMarkerOwner = marker;
		updateLayers();
	}

	function rotateBy(delta) {
		if (!currentState) {
			return;
		}

		const viewState = currentState.viewState;
		const nextViewState = {
			...viewState,
			rotationOrbit: viewState.rotationOrbit + delta.rotationOrbit,
			rotationX: clamp(
				viewState.rotationX + delta.rotationX,
				viewState.minRotationX,
				viewState.maxRotationX,
			),
		};

		setViewState(nextViewState);
		requestAnimationFrame(updateLayers);
		requestViewChange();
	}

	new ResizeObserver(requestViewChangeAfterResize).observe(mapElement);

	return {
		render,
		projectPosition,
		rotateBy,
		setAuxiliaryMarkerOwner,
		setMainPathVisible,
		setPinCategoryVisible,
	};
}
