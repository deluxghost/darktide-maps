import { Deck, OrbitView, OrbitController } from "@deck.gl/core";
import { APP_CONFIG } from "../config.js";
import { createMesh } from "./navmesh.js";
import { pickNavmeshCoordinates } from "./picking.js";
import { viewDepth, pinInFloorRange } from "../markers/pins.js";
import { constrainedViewState, createOrbitViewportForViewState, viewportCenter } from "./view.js";
import { createMapLayers } from "./layers.js";
import { createPinOcclusion } from "./pin_occlusion.js";

const RUNTIME = APP_CONFIG.runtime;
const TOUCH_TILT_DEGREES = 180;

function squaredDistance2d(left, right) {
	return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2;
}

function sharedVerticalDrag(pointers, previousPointers) {
	const [first, second] = pointers.map((pointer, index) => ({
		x: pointer[0] - previousPointers[index][0],
		y: pointer[1] - previousPointers[index][1],
	}));
	const alignment = first.x * second.x + first.y * second.y;
	if (alignment <= 0) return 0;
	// Blend directional agreement so changing direction does not switch tilt abruptly.
	const agreement = alignment / (Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y));
	if (first.y > 0 && second.y > 0) return Math.min(first.y, second.y) * agreement;
	if (first.y < 0 && second.y < 0) return Math.max(first.y, second.y) * agreement;
	return 0;
}

export function createMapRenderer(mapElement, onError) {
	let deckInstance;
	let currentState;
	let viewChangeFrame = 0;
	let layerUpdateFrame = 0;
	let renderToken = 0;
	let pinchGesture = null;
	const pinOcclusion = createPinOcclusion(requestLayerUpdate, onError);

	class MapController extends OrbitController {
		constructor(options) {
			super(options);
			this.events = ["pinchcancel"];
		}

		handleEvent(event) {
			return super.handleEvent(event.type === "pinchcancel" ? {...event, type: "pinchend"} : event);
		}

		_onPinchStart(event) {
			if (!currentState) return false;
			const pixel = this.getCenter(event);
			pinchGesture = {
				anchor: sampleRotationAnchor(pixel), startPixel: pixel, pixel,
				startZoom: currentState.viewState.zoom, startRotation: event.rotation,
				startRotationX: currentState.viewState.rotationX,
				previousPointers: event.pointers.map((pointer) => [pointer.clientX, pointer.clientY]),
				height: mapElement.getBoundingClientRect().height,
			};
			return super._onPinchStart(event);
		}

		_onPinch(event) {
			if (!pinchGesture || !this.isDragging()) return false;

			const pixel = this.getCenter(event);
			const pointers = event.pointers.map((pointer) => [pointer.clientX, pointer.clientY]);
			let tiltDistance = 0;
			// Pointer events arrive separately; consume shared motion after both advance.
			if (pointers.every((pointer, index) => squaredDistance2d(pointer, pinchGesture.previousPointers[index]) > 0)) {
				tiltDistance = sharedVerticalDrag(pointers, pinchGesture.previousPointers);
				pinchGesture.previousPointers = pointers;
			}
			const tiltRotation = currentState.viewState.rotationX - pinchGesture.startRotationX
				+ tiltDistance / pinchGesture.height * TOUCH_TILT_DEGREES;
			pinchGesture.pixel = [pixel[0], pinchGesture.startPixel[1]];
			const state = this.controllerState
				.zoom({pos: pinchGesture.pixel, scale: event.scale})
				.rotate({
					deltaAngleX: pinchGesture.startRotation - event.rotation,
					deltaAngleY: tiltRotation,
				});
			this.updateViewport(state, {transitionDuration: 0}, {
				isDragging: true, isPanning: true, isZooming: true, isRotating: true,
			});
			return true;
		}

		_onPinchEnd(event) {
			const handled = super._onPinchEnd(event);
			pinchGesture = null;
			return handled;
		}
	}

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

	function rotationAnchorSamples(viewport, center = viewportCenter(viewport)) {
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

	function sampleRotationAnchor(center) {
		const viewport = currentViewport();

		if (!viewport) {
			return null;
		}

		const hits = [];

		const samples = rotationAnchorSamples(viewport, center);
		const coordinates = pickNavmeshCoordinates(deckInstance, samples.map((sample) => sample.pixel), navmeshSurfaceLayerIds());
		for (const [index, sample] of samples.entries()) {
			const coordinate = coordinates[index];

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
		const anchor = pinchGesture ? pinchGesture.anchor : rotationAnchor();
		const viewport = currentViewport();

		if (!anchor || !viewport) {
			return viewState;
		}

		const anchoredViewport = createOrbitViewportForViewState(viewport, viewState);
		// The same world pivot moves on screen when a pinch also zooms or pans.
		const scale = pinchGesture ? 2 ** (viewState.zoom - pinchGesture.startZoom) : 1;
		const pixel = pinchGesture
			? pinchGesture.pixel.map((value, axis) => value + scale * (anchor.pixel[axis] - pinchGesture.startPixel[axis]))
			: anchor.pixel;

		return {
			...viewState,
			target: anchoredViewport.panByPosition(anchor.coordinate, pixel).target,
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
		return createMapLayers(currentState, currentViewport());
	}

	function updateLayers() {
		if (deckInstance) {
			deckInstance.setProps({ layers: createLayers() });
		}
	}

	function requestLayerUpdate() {
		if (layerUpdateFrame) return;
		layerUpdateFrame = requestAnimationFrame(() => {
			layerUpdateFrame = 0;
			updateLayers();
		});
	}

	function pickMapCoordinate(x, y) {
		if (!deckInstance || !currentState?.onMapCoordinatePick) {
			return;
		}

		const layerIds = [];

		if (currentState.terrainClipVisible && currentState.terrainClipMeshes) {
			for (const part of Object.keys(currentState.terrainClipMeshes)) {
				layerIds.push(`diagnostic-terrain-clip-fill-${part}-${currentState.map.id}`);
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
		pinchGesture = null;
		const viewState = constrainedViewState(map, options.fitPositions, {
			width: mapElement.clientWidth || window.innerWidth,
			height: mapElement.clientHeight || window.innerHeight,
		});
		const token = ++renderToken;
		pinOcclusion.setMap(navmeshGlb, options.markerPins);

		currentState = {
			map,
			token,
			mesh: createMesh(navmeshGlb, options.heightColors),
			pinOcclusion,
			boundaryPaths,
			mainPathMeshes,
			terrainClipMeshes: options.terrainClipMeshes,
			floorRange: null,
			terrainClipVisible: options.terrainClipVisible,
			mainPathVisible: options.mainPathVisible,
			markerPins: options.markerPins,
			pinById: new Map(options.markerPins.map((pin) => [pin.id, pin])),
			pinOrder: new Map(options.markerPins.map((pin, index) => [pin.id, index])),
			relations: map.markers ? map.markers.relations : [],
			visiblePinCategories: new Set(options.visiblePinCategories),
			onMarkerClick: options.onMarkerClick,
			onMarkerHover: options.onMarkerHover,
			onMapCoordinatePick: options.onMapCoordinatePick,
			onViewChange: options.onViewChange,
			auxiliaryMarkerOwner: null,
			viewState,
		};
		if (!Array.isArray(currentState.relations)) throw new Error(`Missing marker relations for ${map.id}`);
		for (const relation of currentState.relations) {
			if (relation.kind !== "carry"
				|| !currentState.pinById.has(relation.from) || !currentState.pinById.has(relation.to)) {
				throw new Error(`Invalid marker relation in ${map.id}: ${JSON.stringify(relation)}`);
			}
		}

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
			// Start two-finger gestures without requiring an initial pinch scale change.
			eventRecognizerOptions: {pinch: {threshold: -1}},
			onLoad: () => {
				updateLayers();
				requestViewChange();
			},
			views: new OrbitView({
				id: "map",
				near: RUNTIME.view.near,
				far: RUNTIME.view.far,
				controller: {type: MapController, dragMode: "pan", touchRotate: true},
				orbitAxis: RUNTIME.controls.orbitAxis,
				orthographic: RUNTIME.controls.orthographic,
			}),
			viewState,
			layers: createLayers(),
			onError,
			onAfterRender: () => {
				if (currentState) pinOcclusion.update(currentViewport(), currentState.floorRange);
			},
			onViewStateChange: ({viewState: nextViewState, interactionState}) => {
				if (!currentState) return nextViewState;
				const previousViewState = currentState.viewState;
				const rotating = Boolean(interactionState?.isRotating);
				const adjustedViewState = pinchGesture || rotating && rotationChanged(nextViewState, previousViewState)
					? applyRotationAnchor(nextViewState)
					: nextViewState;

				if (!rotating) {
					clearRotationAnchor();
				}

				setViewState(adjustedViewState);

				if (rotationChanged(adjustedViewState, previousViewState)) {
					requestLayerUpdate();
				}

				requestViewChange();

				return adjustedViewState;
			},
			onClick: (info, event) => {
				if (!currentState) return false;
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
				if (!currentState) return;
				const hoveredMarker = info.object?.markerType === "pin" || info.object?.markerType === "auxiliary_pin"
					? info.object
					: null;
				if (currentState.hoveredMarker?.id === hoveredMarker?.id) return;

				currentState.hoveredMarker = hoveredMarker;
				currentState.onMarkerHover?.(hoveredMarker);
			},
			getCursor: () => currentState?.hoveredMarker ? "pointer" : null,
		});

	}

	function clear() {
		pinOcclusion.clear();
		pinchGesture = null;
		currentState = null;
		updateLayers();
	}

	function projectMarkers(markers) {
		const viewport = currentViewport();
		if (!viewport || !currentState) return null;
		const bounds = mapElement.getBoundingClientRect();
		const matrix = viewport.pixelProjectionMatrix;
		// Translation moves the overlay without changing its screen-space curves.
		const viewKey = [matrix[0], matrix[1], matrix[4], matrix[5], matrix[8], matrix[9]].join("|");
		return {bounds, viewKey, points: markers.map((marker, index) => {
			const [x, y] = viewport.project(marker.position);
			return {marker, x: bounds.left + x, y: bounds.top + y, depth: viewDepth(marker, viewport),
				order: currentState.pinOrder.get(marker.id) ?? currentState.pinOrder.size + index};
		})};
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

	function setTerrainClipVisible(visible) {
		if (!currentState) {
			return;
		}

		currentState.terrainClipVisible = visible;
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

	function markerRelations(marker) {
		if (!currentState || !marker) return [];
		return currentState.relations.filter((relation) => relation.from === marker.id || relation.to === marker.id)
			.map((relation) => ({...relation, from: currentState.pinById.get(relation.from), to: currentState.pinById.get(relation.to)}))
			.filter(({from, to}) => currentState.visiblePinCategories.has(from.category) && currentState.visiblePinCategories.has(to.category)
				&& pinInFloorRange(from, currentState.floorRange) && pinInFloorRange(to, currentState.floorRange));
	}

	new ResizeObserver(requestViewChangeAfterResize).observe(mapElement);

	return {
		clear,
		render,
		centerOnPosition,
		projectMarkers,
		markerRelations,
		setAuxiliaryMarkerOwner,
		setTerrainClipVisible,
		setFloorSelection,
		setMainPathVisible,
		setPinCategoryVisible,
	};
}
