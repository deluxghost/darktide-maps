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

function midpoint(min, max) {
	return [
		(min[0] + max[0]) / 2,
		(min[1] + max[1]) / 2,
		(min[2] + max[2]) / 2,
	];
}

function initialZoom(bounds) {
	const width = Math.max(bounds.max[0] - bounds.min[0], 1);
	const height = Math.max(bounds.max[1] - bounds.min[1], 1);
	const scale = Math.min(window.innerWidth / width, window.innerHeight / height);

	return Math.log2(scale) - 1;
}

function constrainedViewState(bounds) {
	return {
		target: midpoint(bounds.min, bounds.max),
		rotationOrbit: 0,
		rotationX: 55,
		minRotationX: 5,
		maxRotationX: 90,
		minZoom: VISUAL_CONFIG.runtime.view.minZoom,
		maxZoom: VISUAL_CONFIG.runtime.view.maxZoom,
		zoom: initialZoom(bounds),
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
		const viewState = constrainedViewState(map.bounds);

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
