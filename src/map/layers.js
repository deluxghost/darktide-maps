import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { IconLayer, PathLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { APP_CONFIG } from "../config.js";
import { FloorClipExtension } from "./floorclip.js";
import { NavmeshDepthExtension } from "./picking.js";
import { pinIconForCategory, positionMarkerIcon } from "../markers/icons.js";
import { sortedPins, auxiliaryPinsForMarker } from "../markers/pins.js";

const RUNTIME = APP_CONFIG.runtime;
const VISUAL = RUNTIME.visual;
const FLOOR_CLIP_EXTENSION = new FloorClipExtension();
const FLOOR_PATH_EXTENSION = new FloorClipExtension({path: true});
const NAVMESH_DEPTH_EXTENSION = new NavmeshDepthExtension();
const OVERLAY_LINE_PARAMETERS = {
	blend: false,
	depthCompare: "less-equal",
	depthMask: false,
	depthTest: true,
	depthWriteEnabled: false,
	depthBias: VISUAL.navmesh.boundaryDepthBias,
	depthBiasSlopeScale: VISUAL.navmesh.boundaryDepthBiasSlopeScale,
};

export function createMapLayers(currentState, viewport) {
	if (!currentState) {
		return [];
	}

	const {
		map,
		mesh,
		boundaryPaths,
		mainPathMeshes,
		terrainClipMeshes,
		terrainClipVisible,
		mainPathVisible,
		markerPins,
		auxiliaryMarkerOwner,
		visiblePinCategories,
		floorRange,
	} = currentState;
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
			extensions: [FLOOR_CLIP_EXTENSION, NAVMESH_DEPTH_EXTENSION],
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

	if (terrainClipVisible) {
		addPartMeshLayers(terrainClipMeshes, (part, partData) => createStaticMeshLayer({
			id: `diagnostic-terrain-clip-fill-${part}-${map.id}`,
			layerMesh: partData.mesh,
			color: VISUAL.terrainClip.fillColor,
			material: VISUAL.lighting.terrainClipMaterial,
			parameters: RUNTIME.layers.diagnosticFillParameters,
			pickable: Boolean(currentState.onMapCoordinatePick),
		}));
		addPartMeshLayers(terrainClipMeshes, (part, partData) => createBoundaryLayer({
			id: `diagnostic-terrain-clip-outline-${part}-${map.id}`,
			paths: partData.boundaryPaths,
			color: VISUAL.terrainClip.outlineColor,
			width: VISUAL.terrainClip.outlineWidth,
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
