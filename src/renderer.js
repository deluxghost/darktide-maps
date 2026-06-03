import { COORDINATE_SYSTEM, Deck, OrbitView } from "@deck.gl/core";
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

function midpoint(min, max) {
	return [
		(min[0] + max[0]) / 2,
		(min[1] + max[1]) / 2,
		(min[2] + max[2]) / 2,
	];
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function viewDepth(pin, viewport) {
	const position = pin.position;
	const matrix = viewport.viewMatrix;

	return matrix[2] * position[0] + matrix[6] * position[1] + matrix[10] * position[2] + matrix[14];
}

function sortedPins(pins, visibleCategories, viewport) {
	const visiblePins = pins.filter((pin) => visibleCategories.has(pin.category));

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

function boundsSize(bounds) {
	return {
		width: Math.max(bounds.max[0] - bounds.min[0], RUNTIME.view.minWorldSize),
		height: Math.max(bounds.max[1] - bounds.min[1], RUNTIME.view.minWorldSize),
	};
}

function initialZoom(bounds, viewport) {
	const size = boundsSize(bounds);
	const scale = Math.min(viewport.width / size.width, viewport.height / size.height);

	return Math.log2(scale * RUNTIME.view.initialViewPadding);
}

function constrainedViewState(bounds, positions, viewport) {
	const fitBounds = boundsFromPositions(positions) ?? bounds;

	return {
		target: midpoint(fitBounds.min, fitBounds.max),
		rotationOrbit: 0,
		rotationX: RUNTIME.view.initialRotationX,
		minRotationX: RUNTIME.view.minRotationX,
		maxRotationX: RUNTIME.view.maxRotationX,
		minZoom: RUNTIME.view.minZoom,
		maxZoom: RUNTIME.view.maxZoom,
		zoom: clamp(
			initialZoom(fitBounds, viewport),
			RUNTIME.view.minZoom,
			RUNTIME.view.maxZoom,
		),
	};
}

export function createMapRenderer(mapElement, onError) {
	let deckInstance;
	let currentState;

	function createLayers() {
		if (!currentState) {
			return [];
		}

		const { map, mesh, boundaryPaths, mainPathMeshes, mainPathVisible, markerPins, visiblePinCategories } = currentState;
		const viewport = deckInstance?.getViewports()[0];
		const visiblePins = sortedPins(markerPins, visiblePinCategories, viewport);
		const layers = [
			new SimpleMeshLayer({
				id: `navmesh-surface-${map.id}`,
				data: [{}],
				mesh,
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				getPosition: [0, 0, 0],
				getColor: [255, 255, 255, 255],
				wireframe: false,
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
			getIcon: (pin) => pinIconForCategory(pin.category),
			getSize: VISUAL.pins.iconHeight,
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

	function render(map, mesh, boundaryPaths, mainPathMeshes, options) {
		const viewState = constrainedViewState(map.bounds, options.fitPositions, {
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
			onViewChange: options.onViewChange,
			viewState,
		};

		if (deckInstance) {
			deckInstance.setProps({
				initialViewState: viewState,
				layers: createLayers(),
			});

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
			initialViewState: viewState,
			layers: createLayers(),
			onError,
			onViewStateChange: ({viewState: nextViewState}) => {
				const previousViewState = currentState.viewState;

				currentState.viewState = nextViewState;

				if (
					nextViewState.rotationOrbit !== previousViewState.rotationOrbit
					|| nextViewState.rotationX !== previousViewState.rotationX
				) {
					requestAnimationFrame(updateLayers);
				}

				requestAnimationFrame(() => currentState.onViewChange?.());
			},
			onClick: (info) => {
				if (info.object?.markerType === "pin") {
					currentState.onMarkerClick(info.object, info.x, info.y);

					return true;
				}

				currentState.onMarkerClick(null);

				return false;
			},
			onHover: (info) => {
				currentState.onMarkerHover?.(info.object?.markerType === "pin" ? info.object : null);
			},
			getCursor: ({isHovering}) => isHovering ? "pointer" : null,
		});

		requestAnimationFrame(updateLayers);
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

	return {
		render,
		projectPosition,
		setMainPathVisible,
		setPinCategoryVisible,
	};
}
