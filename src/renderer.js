import { COORDINATE_SYSTEM, Deck, OrbitView, OrbitViewport } from "@deck.gl/core";
import { IconLayer, PathLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { APP_CONFIG } from "./config.js";
import { FloorClipExtension } from "./floorclip.js";
import { pinIconForCategory, positionMarkerIcon } from "./icons.js";
import { createMesh } from "./navmesh.js";

const RUNTIME = APP_CONFIG.runtime;
const VISUAL = RUNTIME.visual;
const FLOOR_CLIP_EXTENSION = new FloorClipExtension();
const FLOOR_PATH_EXTENSION = new FloorClipExtension({path: true});
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

function pinFloorIndex(pin) {
	return pin.markerType === "auxiliary_pin"
		? pin.parentMarker?.floorIndex
		: pin.floorIndex;
}

function pinInFloorRange(pin, range) {
	if (!range) {
		return true;
	}

	if (pin.markerType === "position_marker") {
		return true;
	}

	const floorIndex = pinFloorIndex(pin);

	return Number.isInteger(floorIndex) && floorIndex >= range[0] && floorIndex < range[1];
}

function sortedPins(pins, visibleCategories, viewport, floorRange) {
	const visiblePins = pins.filter((pin) => (
		visibleCategories.has(pin.category)
		|| pin.markerType === "auxiliary_pin"
		|| pin.markerType === "position_marker"
	) && pinInFloorRange(pin, floorRange));

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

function createOrbitViewportForViewState(viewport, viewState) {
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

function squaredDistance2d(left, right) {
	return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2;
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
	let renderToken = 0;

	function currentViewport() {
		return deckInstance?.isInitialized ? deckInstance.getViewports()[0] : null;
	}

	function nextFrame() {
		return new Promise((resolve) => requestAnimationFrame(resolve));
	}

	function currentViewportSize() {
		return {
			width: mapElement.clientWidth || window.innerWidth,
			height: mapElement.clientHeight || window.innerHeight,
		};
	}

	function viewStateReady(viewState) {
		return Array.isArray(viewState?.target)
			&& viewState.target.every(Number.isFinite)
			&& Number.isFinite(viewState.zoom)
			&& Number.isFinite(viewState.rotationOrbit)
			&& Number.isFinite(viewState.rotationX);
	}

	function navmeshSurfaceLayerIds() {
		if (!currentState?.mesh) {
			return [];
		}

		return [`navmesh-surface-${currentState.map.id}`];
	}

	function pickNavmeshCoordinate(pixel) {
		if (!deckInstance || !currentState) {
			return null;
		}

		const picked = deckInstance.pickObject({
			x: pixel[0],
			y: pixel[1],
			layerIds: navmeshSurfaceLayerIds(),
			unproject3D: true,
		});

		return picked?.coordinate ?? null;
	}

	function rotationAnchorSamples(viewport) {
		const center = viewportCenter(viewport);
		const {sampleRadius, sampleStep} = RUNTIME.controls.rotationAnchor;
		const samples = [];

		for (let y = -sampleRadius; y <= sampleRadius; y += sampleStep) {
			for (let x = -sampleRadius; x <= sampleRadius; x += sampleStep) {
				if (x * x + y * y > sampleRadius * sampleRadius) {
					continue;
				}

				const pixel = [center[0] + x, center[1] + y];

				if (pixel[0] < 0 || pixel[0] > viewport.width || pixel[1] < 0 || pixel[1] > viewport.height) {
					continue;
				}

				samples.push({
					pixel,
					distance: squaredDistance2d(pixel, center),
				});
			}
		}

		return samples.sort((left, right) => left.distance - right.distance);
	}

	function groupedRotationAnchorHits(hits) {
		const groups = [];
		const tolerance = RUNTIME.controls.rotationAnchor.heightTolerance;

		for (const hit of hits) {
			const height = hit.coordinate[2];
			let group = groups.find((entry) => Math.abs(entry.height - height) <= tolerance);

			if (!group) {
				group = {
					height,
					hits: [],
					minDistance: Infinity,
				};
				groups.push(group);
			}

			group.hits.push(hit);
			group.height += (height - group.height) / group.hits.length;
			group.minDistance = Math.min(group.minDistance, hit.distance);
		}

		return groups;
	}

	function dominantRotationAnchorHit(hits) {
		const groups = groupedRotationAnchorHits(hits);

		if (groups.length === 0) {
			return null;
		}

		groups.sort((left, right) => (
			right.hits.length - left.hits.length
			|| left.minDistance - right.minDistance
		));

		return [...groups[0].hits]
			.sort((left, right) => left.distance - right.distance)[0];
	}

	function sampleRotationAnchor() {
		const viewport = currentViewport();

		if (!viewport) {
			return null;
		}

		const hits = [];

		for (const sample of rotationAnchorSamples(viewport)) {
			const coordinate = pickNavmeshCoordinate(sample.pixel);

			if (!coordinate) {
				continue;
			}

			hits.push({
				...sample,
				coordinate,
			});
		}

		const hit = dominantRotationAnchorHit(hits);

		return hit ? {
			pixel: hit.pixel,
			coordinate: hit.coordinate,
		} : null;
	}

	function clearRotationAnchor() {
		if (currentState) {
			currentState.rotationAnchor = undefined;
		}
	}

	function rotationAnchor() {
		if (!currentState) {
			return null;
		}

		if (currentState.rotationAnchor === undefined) {
			currentState.rotationAnchor = sampleRotationAnchor();
		}

		return currentState.rotationAnchor;
	}

	function applyRotationAnchor(viewState) {
		const anchor = rotationAnchor();
		const viewport = currentViewport();

		if (!anchor || !viewport) {
			return viewState;
		}

		const anchoredViewport = createOrbitViewportForViewState(viewport, viewState);

		return {
			...viewState,
			target: anchoredViewport.panByPosition(anchor.coordinate, anchor.pixel).target,
		};
	}

	function rotationChanged(left, right) {
		return left.rotationOrbit !== right.rotationOrbit || left.rotationX !== right.rotationX;
	}

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

		const {
			map,
			mesh,
			boundaryPaths,
			mainPathMeshes,
			blockedEdgeMeshes,
			blockedEdgesVisible,
			mainPathVisible,
			markerPins,
			auxiliaryMarkerOwner,
			visiblePinCategories,
			floorRange,
		} = currentState;
		const viewport = currentViewport();
		const auxiliaryPins = auxiliaryPinsForMarker(auxiliaryMarkerOwner);
		const visiblePins = sortedPins(
			auxiliaryPins.length ? [...markerPins, ...auxiliaryPins] : markerPins,
			visiblePinCategories,
			viewport,
			floorRange,
		);
		const layers = [];

		function addPartMeshLayers(parts, createLayer) {
			if (!parts) {
				return;
			}

			for (const [part, partData] of Object.entries(parts)) {
				if (!partData.mesh) {
					continue;
				}

				layers.push(createLayer(part, partData));
			}
		}

		function createStaticMeshLayer({
			id,
			layerMesh,
			color,
			material,
			parameters = RUNTIME.layers.opaqueMeshParameters,
			pickable = false,
		}) {
			return new SimpleMeshLayer({
				id,
				data: [{}],
				mesh: layerMesh,
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				getPosition: [0, 0, 0],
				getColor: color,
				wireframe: false,
				pickable,
				material,
				getPolygonOffset: () => [0, 0],
				parameters,
				_instanced: false,
				extensions: [FLOOR_CLIP_EXTENSION],
				floorRange,
			});
		}

		function createBoundaryLayer({id, paths, color, width, parameters}) {
			return new PathLayer({
				id,
				data: paths,
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				getPath: (boundary) => boundary.path,
				getColor: color,
				getWidth: width,
				widthUnits: "common",
				jointRounded: true,
				capRounded: true,
				getPolygonOffset: () => [0, 0],
				parameters,
				extensions: [FLOOR_PATH_EXTENSION],
				floorRange,
			});
		}

		if (mesh) {
			layers.push(createStaticMeshLayer({
				id: `navmesh-surface-${map.id}`,
				layerMesh: mesh,
				color: [255, 255, 255, 255],
				material: VISUAL.lighting.navmeshMaterial,
				pickable: true,
			}));
		}

		layers.push(createBoundaryLayer({
			id: `navmesh-boundaries-${map.id}`,
			paths: boundaryPaths,
			color: VISUAL.navmesh.boundaryColor,
			width: VISUAL.navmesh.boundaryWidth,
			parameters: OVERLAY_LINE_PARAMETERS,
		}));

		if (mainPathMeshes && mainPathVisible) {
			addPartMeshLayers(mainPathMeshes, (part, partData) => createStaticMeshLayer({
				id: `landmark-main-path-${part}-${map.id}`,
				layerMesh: partData.mesh,
				color: VISUAL.mainPath[`${part}Color`],
				material: VISUAL.lighting.mainPathMaterial,
			}));
		}

		if (blockedEdgesVisible) {
			addPartMeshLayers(blockedEdgeMeshes, (part, partData) => createStaticMeshLayer({
				id: `diagnostic-blocked-edges-fill-${part}-${map.id}`,
				layerMesh: partData.mesh,
				color: VISUAL.blockedEdges.fillColor,
				material: VISUAL.lighting.blockedEdgesMaterial,
				parameters: RUNTIME.layers.diagnosticFillParameters,
				pickable: Boolean(currentState.onMapCoordinatePick),
			}));
			addPartMeshLayers(blockedEdgeMeshes, (part, partData) => createBoundaryLayer({
				id: `diagnostic-blocked-edges-outline-${part}-${map.id}`,
				paths: partData.boundaryPaths,
				color: VISUAL.blockedEdges.outlineColor,
				width: VISUAL.blockedEdges.outlineWidth,
				parameters: RUNTIME.layers.diagnosticOutlineParameters,
			}));
		}

		layers.push(new IconLayer({
			id: `pin-markers-${map.id}`,
			data: visiblePins,
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			getPosition: (pin) => pin.position,
			getIcon: (pin) => pin.markerType === "position_marker"
				? positionMarkerIcon()
				: pinIconForCategory(pin.category, {
					centerCircle: pin.markerType !== "auxiliary_pin",
					iconWidth: pin.markerType === "auxiliary_pin" ? VISUAL.pins.iconWidth * VISUAL.auxiliaryLinks.auxiliaryPinScale : undefined,
					iconHeight: pin.markerType === "auxiliary_pin" ? VISUAL.pins.iconHeight * VISUAL.auxiliaryLinks.auxiliaryPinScale : undefined,
					strokeWidth: pin.markerType === "auxiliary_pin" ? VISUAL.auxiliaryLinks.auxiliaryPinStrokeWidth : undefined,
				}),
			getSize: (pin) => pin.markerType === "auxiliary_pin"
				? VISUAL.pins.iconHeight * VISUAL.auxiliaryLinks.auxiliaryPinScale
				: pin.markerType === "position_marker"
					? VISUAL.positionMarker.iconSize
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

		const layerIds = [];

		if (currentState.blockedEdgesVisible && currentState.blockedEdgeMeshes) {
			for (const part of Object.keys(currentState.blockedEdgeMeshes)) {
				layerIds.push(`diagnostic-blocked-edges-fill-${part}-${currentState.map.id}`);
			}
		}

		layerIds.push(...navmeshSurfaceLayerIds());

		if (layerIds.length === 0) {
			currentState.onMapCoordinatePick(null);

			return;
		}

		const picked = deckInstance.pickObject({
			x,
			y,
			layerIds,
			unproject3D: true,
		});

		currentState.onMapCoordinatePick(picked?.coordinate ?? null);
	}

	function render(map, navmeshGlb, boundaryPaths, mainPathMeshes, options) {
		const viewState = constrainedViewState(map, options.fitPositions, {
			width: mapElement.clientWidth || window.innerWidth,
			height: mapElement.clientHeight || window.innerHeight,
		});
		const token = ++renderToken;

		currentState = {
			map,
			token,
			mesh: createMesh(navmeshGlb),
			boundaryPaths,
			mainPathMeshes,
			blockedEdgeMeshes: options.blockedEdgeMeshes,
			floorRange: null,
			blockedEdgesVisible: options.blockedEdgesVisible,
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
			onLoad: () => {
				updateLayers();
				requestViewChange();
			},
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
			onViewStateChange: ({viewState: nextViewState, interactionState}) => {
				const previousViewState = currentState.viewState;
				const rotating = Boolean(interactionState?.isRotating);
				const adjustedViewState = rotating && rotationChanged(nextViewState, previousViewState)
					? applyRotationAnchor(nextViewState)
					: nextViewState;

				if (!rotating) {
					clearRotationAnchor();
				}

				setViewState(adjustedViewState);

				if (rotationChanged(adjustedViewState, previousViewState)) {
					requestAnimationFrame(updateLayers);
				}

				requestViewChange();

				return adjustedViewState;
			},
			onClick: (info, event) => {
				if (isCtrlClick(event) && currentState.onMapCoordinatePick) {
					pickMapCoordinate(info.x, info.y);

					return true;
				}

				if (info.object?.markerType === "auxiliary_pin") {
					return true;
				}

				if (info.object?.markerType === "position_marker") {
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

	}

	function projectPosition(position) {
		const viewport = currentViewport();

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

	async function centerOnPosition(position, mapId) {
		if (!position?.every(Number.isFinite) || !mapId || !currentState) {
			throw new Error("Cannot center on an invalid map position.");
		}

		const token = currentState.token;

		while (true) {
			await nextFrame();

			if (!currentState || currentState.map.id !== mapId || currentState.token !== token) {
				return false;
			}

			const viewport = currentViewportSize();

			if (!deckInstance || viewport.width <= 0 || viewport.height <= 0 || !viewStateReady(currentState.viewState)) {
				continue;
			}

			const orbitViewport = createOrbitViewportForViewState(viewport, currentState.viewState);
			const viewState = {
				...currentState.viewState,
				target: orbitViewport.panByPosition(position, viewportCenter(viewport)).target,
			};

			if (!viewStateReady(viewState)) {
				continue;
			}

			setViewState(viewState);
			requestViewChange();

			return true;
		}
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

	function setBlockedEdgesVisible(visible) {
		if (!currentState) {
			return;
		}

		currentState.blockedEdgesVisible = visible;
		updateLayers();
	}

	function sameFloorRange(left, right) {
		if (!left || !right) {
			return left === right;
		}

		return left[0] === right[0] && left[1] === right[1];
	}

	function setFloorSelection(selection) {
		const floorRange = selection?.floorRange ?? null;

		if (!currentState || sameFloorRange(currentState.floorRange, floorRange)) {
			return;
		}

		currentState.floorRange = floorRange;
		currentState.rotationAnchor = undefined;
		updateLayers();
		requestViewChange();
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
		const adjustedViewState = applyRotationAnchor(nextViewState);

		setViewState(adjustedViewState);
		requestAnimationFrame(updateLayers);
		requestViewChange();
	}

	new ResizeObserver(requestViewChangeAfterResize).observe(mapElement);

	return {
		render,
		centerOnPosition,
		clearRotationAnchor,
		projectPosition,
		rotateBy,
		setAuxiliaryMarkerOwner,
		setBlockedEdgesVisible,
		setFloorSelection,
		setMainPathVisible,
		setPinCategoryVisible,
	};
}
