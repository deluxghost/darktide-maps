import { COORDINATE_SYSTEM, Deck, OrbitView } from "@deck.gl/core";
import { PathLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { VISUAL_CONFIG } from "./config.js";

const OPAQUE_MESH_PARAMETERS = {
	blend: false,
	depthCompare: "less-equal",
	depthMask: true,
	depthTest: true,
	depthWriteEnabled: true,
	polygonOffsetFill: false,
};

const OVERLAY_LINE_PARAMETERS = {
	blend: false,
	depthCompare: "less-equal",
	depthMask: false,
	depthTest: true,
	depthWriteEnabled: false,
	polygonOffsetFill: false,
};

const INITIAL_ROTATION_X = 55;
const INITIAL_VIEW_PADDING = 0.8;
const MIN_WORLD_SIZE = 1;

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
		width: Math.max(bounds.max[0] - bounds.min[0], MIN_WORLD_SIZE),
		height: Math.max(bounds.max[1] - bounds.min[1], MIN_WORLD_SIZE),
	};
}

function initialZoom(bounds, viewport) {
	const size = boundsSize(bounds);
	const scale = Math.min(viewport.width / size.width, viewport.height / size.height);

	return Math.log2(scale * INITIAL_VIEW_PADDING);
}

function constrainedViewState(bounds, positions, viewport) {
	const fitBounds = boundsFromPositions(positions) ?? bounds;

	return {
		target: midpoint(fitBounds.min, fitBounds.max),
		rotationOrbit: 0,
		rotationX: INITIAL_ROTATION_X,
		minRotationX: 5,
		maxRotationX: 90,
		minZoom: VISUAL_CONFIG.runtime.view.minZoom,
		maxZoom: VISUAL_CONFIG.runtime.view.maxZoom,
		zoom: clamp(
			initialZoom(fitBounds, viewport),
			VISUAL_CONFIG.runtime.view.minZoom,
			VISUAL_CONFIG.runtime.view.maxZoom,
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

		const { map, mesh, boundaryPaths, mainPathMeshes, mainPathVisible } = currentState;
		const layers = [
			new SimpleMeshLayer({
				id: `navmesh-surface-${map.id}`,
				data: [{}],
				mesh,
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				getPosition: [0, 0, 0],
				getColor: [255, 255, 255, 255],
				wireframe: false,
				material: VISUAL_CONFIG.runtime.lighting.navmeshMaterial,
				getPolygonOffset: () => [0, 0],
				parameters: OPAQUE_MESH_PARAMETERS,
			}),
		];

		layers.push(new PathLayer({
			id: `navmesh-boundaries-${map.id}`,
			data: boundaryPaths,
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			getPath: (boundary) => boundary.path,
			getColor: VISUAL_CONFIG.runtime.navmesh.boundaryColor,
			getWidth: VISUAL_CONFIG.runtime.navmesh.boundaryWidth,
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
					getColor: VISUAL_CONFIG.runtime.mainPath[`${part}Color`],
					wireframe: false,
					material: VISUAL_CONFIG.runtime.lighting.mainPathMaterial,
					getPolygonOffset: () => [0, 0],
					parameters: OPAQUE_MESH_PARAMETERS,
				}));
			}
		}

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
				near: VISUAL_CONFIG.runtime.view.near,
				far: VISUAL_CONFIG.runtime.view.far,
				controller: {
					dragMode: "pan",
					touchRotate: true,
				},
				orbitAxis: "Z",
				orthographic: true,
			}),
			initialViewState: viewState,
			layers: createLayers(),
			onError,
		});
	}

	function setMainPathVisible(visible) {
		if (!currentState) {
			return;
		}

		currentState.mainPathVisible = visible;
		updateLayers();
	}

	return {
		render,
		setMainPathVisible,
	};
}
