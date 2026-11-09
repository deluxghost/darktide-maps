import { parseGlb } from "./data/glb.js";
import { applyTranslations, loadGameText, localizeValue, t } from "./i18n.js";
import { createGeometryBoundaryPaths, createLandmarkMesh, createPathBoundaryPaths } from "./map/landmarks.js";
import { APP_CONFIG } from "./config.js";
import { createMapRenderer } from "./map/renderer.js";
import { createHeightColors } from "./map/height_colors.js";
import { isReachableView, navmeshView, viewFloors, viewLayers, viewPins } from "./map/views.js";
import { createFilterController } from "./ui/filters.js";
import { createFloorController } from "./ui/floors.js";
import { createMarkerOverlays } from "./markers/overlays.js";
import { initializeAbout, renderChangelog } from "./ui/about.js";
import { initializeSettings } from "./ui/settings.js";
import { mapTitle, writeMapOptions } from "./data/manifest.js";
import { formatLocalTimestampFromUnix } from "./time.js";
import { createNotifications } from "./ui/notifications.js";
import { readStoredObject, writeStoredProperty } from "./storage.js";
import {
	mapLocationUrl,
	markerLocationUrl,
	pushUrl,
	readLocationRequest,
	replaceUrl,
	tryParsePositionParameter,
} from "./location.js";
import { createElement as createLucideElement, createIcons, Info, Menu, Settings, X } from "lucide";

const mapElement = document.querySelector("#map");
const mapSelect = document.querySelector("#map-select");
const loadingOverlay = document.querySelector("#loading-overlay");
const notificationsElement = document.querySelector("#notifications");
const panel = document.querySelector(".panel");
const panelToggle = document.querySelector("#panel-toggle");
const filterList = document.querySelector("#filter-list");
const markerPopup = document.querySelector("#marker-popup");
const markerPopupTitle = document.querySelector("#marker-popup-title");
const markerPopupType = document.querySelector("#marker-popup-type");
const markerPopupDescription = document.querySelector("#marker-popup-description");
const markerPopupClose = document.querySelector("#marker-popup-close");
const markerTooltip = document.querySelector("#marker-tooltip");
const auxiliaryArrow = document.querySelector("#auxiliary-arrow");
const dataUpdatedElement = document.querySelector("#data-updated");
const floorControl = document.querySelector("#floor-control");
const mobileMedia = window.matchMedia(APP_CONFIG.ui.mobileMediaQuery);
const DEBUG_STORAGE_KEY = "darktide-maps.debug.v1";
const VIEW_STORAGE_KEY = "darktide-maps.view.v1";
const URL_POSITION_MARKER_ID = "url-position";

let loadController;
let currentManifest = null;
let loadingMap = null;
let debugTerrainClippingVisible = readDebugTerrainClippingVisible();
let showUnreachable = readStoredObject(VIEW_STORAGE_KEY).showUnreachable === true;
let loadedMap = null;
const mapDataCache = new Map();
const notifications = createNotifications({
	container: notificationsElement,
	createIcon: () => createLucideElement(X, {"aria-hidden": "true"}),
	dismissLabel: () => t("dismiss"),
});

function formatBytes(bytes) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}

	return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}

function setLoading(map) {
	loadingMap = map;
	loadingOverlay.textContent = t("loadingMap", {
		title: mapTitle(map),
		size: formatBytes(map.resourceBytes + (import.meta.env.DEV ? map.debugResourceBytes : 0)),
	});
	loadingOverlay.hidden = false;
}

function clearLoading() {
	loadingMap = null;
	loadingOverlay.hidden = true;
}

function showError(error) {
	notifications.error(error);
}

function showInfo(message) {
	notifications.info(message);
}

function showWarning(message) {
	notifications.warning(message);
}

function readDebugSettings() {
	if (!import.meta.env.DEV) {
		return {};
	}

	return readStoredObject(DEBUG_STORAGE_KEY);
}

function readDebugTerrainClippingVisible() {
	return readDebugSettings().terrainClippingVisible === true;
}

function writeDebugTerrainClippingVisible(visible) {
	writeStoredProperty(DEBUG_STORAGE_KEY, "terrainClippingVisible", visible);
}

async function copyMarkerUrl(marker) {
	const mapId = marker?.mapId ?? mapSelect.value;

	if (!mapId || !marker?.id) {
		throw new Error(t("errorMarkerUrlUnavailable"));
	}

	const url = markerLocationUrl(mapId, marker.id).toString();

	await navigator.clipboard.writeText(url);
	showInfo(t("markerUrlCopied"));
}

function formatCoordinate(position) {
	return `[${position.map((value) => Number(value.toFixed(3))).join(", ")}]`;
}

function copyMapCoordinate(position) {
	if (!position) {
		showWarning(t("noNavmeshPositionPicked"));
		return;
	}

	const text = formatCoordinate(position);

	navigator.clipboard.writeText(text)
		.then(() => showInfo(t("coordinateCopied", {position: text})))
		.catch(showError);
}

function setPanelCollapsed(collapsed) {
	panel.classList.toggle("collapsed", collapsed);
	panelToggle.setAttribute("aria-expanded", String(!collapsed));
}

function writeDataUpdatedAt(unixTimestamp) {
	dataUpdatedElement.textContent = t("dataUpdatedAt", {
		time: formatLocalTimestampFromUnix(unixTimestamp),
	});
	dataUpdatedElement.hidden = false;
}

function categoryTitle(category) {
	const labelKey = APP_CONFIG.runtime.visual.pins.categories[category]?.labelKey;

	return labelKey ? t(labelKey) : category;
}

function markerName(marker) {
	const name = localizeValue(marker.name, categoryTitle(marker.category));
	return marker.count > 1 ? `${name} ×${marker.count}` : name;
}

const mapRenderer = createMapRenderer(mapElement, showError);
const markerOverlays = createMarkerOverlays({
	markerPopup,
	markerPopupTitle,
	markerPopupType,
	markerPopupDescription,
	markerTooltip,
	auxiliaryArrow,
	mapRenderer,
	categoryTitle,
	markerName,
	onCopyMarkerUrl: copyMarkerUrl,
	onCopyMarkerUrlError: showError,
});
const floorController = createFloorController({
	root: floorControl,
	onChange: (floorSelection) => {
		markerOverlays.hidePopup();
		markerOverlays.hideTooltip();
		mapRenderer.setFloorSelection(floorSelection);
	},
});
const filters = createFilterController({
	filterList,
	mapRenderer,
	categoryTitle,
	onCategoryHidden: markerOverlays.hideForCategory,
});

async function loadGlb(file, signal) {
	const response = await fetch(file, { signal });

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} while loading ${file}`);
	}

	return parseGlb(await response.arrayBuffer());
}

async function loadGeometryParts(asset, signal) {
	return asset?.file ? (await loadGlb(asset.file, signal)).parts : null;
}

function geometryPartMeshes(parts, reachable, includeBoundaries) {
	if (!parts) {
		return null;
	}

	return Object.fromEntries(Object.entries(parts).map(([part, partGlb]) => {
		const glb = viewFloors(partGlb, reachable);
		return [part, {
			mesh: createLandmarkMesh(glb),
			boundaryPaths: includeBoundaries ? createGeometryBoundaryPaths(glb) : undefined,
		}];
	}));
}

async function loadBoundaryPaths(asset, signal) {
	if (!asset?.file) {
		throw new Error("Map data is missing preprocessed navmesh boundaries.");
	}

	const glb = await loadGlb(asset.file, signal);
	const paths = createPathBoundaryPaths(glb);
	const {all} = glb.extras.stats.groups;

	return {all: paths.slice(0, all), reach: paths.slice(all)};
}

async function loadMapData(mapEntry, signal) {
	const useCache = !import.meta.env.DEV;

	if (useCache && mapDataCache.has(mapEntry.id)) {
		return mapDataCache.get(mapEntry.id);
	}

	const response = await fetch(mapEntry.file, {
		signal,
		cache: useCache ? "default" : "no-store",
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} while loading ${mapEntry.file}`);
	}

	const mapData = await response.json();

	if (mapData.id !== mapEntry.id) {
		throw new Error(`Map data id mismatch: ${mapEntry.file}. Expected ${mapEntry.id}, got ${mapData.id}.`);
	}

	const map = {
		...mapEntry,
		...mapData,
	};

	if (useCache) {
		mapDataCache.set(mapEntry.id, map);
	}

	return map;
}

function mapEntryById(manifest, mapId) {
	return manifest.maps.find((map) => map.id === mapId) ?? null;
}

function markerById(map, markerId) {
	return (map.markers?.pins ?? []).find((marker) => marker.id === markerId) ?? null;
}

async function markerLocation(manifest, markerId, preferredMapId, signal) {
	const preferredMap = preferredMapId ? mapEntryById(manifest, preferredMapId) : null;
	const maps = [
		...(preferredMap ? [preferredMap] : []),
		...manifest.maps.filter((map) => map.id !== preferredMapId),
	];

	for (const mapEntry of maps) {
		const map = await loadMapData(mapEntry, signal);
		const marker = markerById(map, markerId);

		if (marker) {
			return {mapEntry, marker};
		}
	}

	return null;
}

async function resolveLocationRequest(manifest, request, signal) {
	let invalidLocationUrl = false;

	function result(mapEntry, locator = null, canonicalUrl = null) {
		if (invalidLocationUrl && !signal.aborted) {
			showWarning(t("errorInvalidLocationUrl"));
		}

		return {mapEntry, locator, canonicalUrl};
	}

	if (request.positionText && request.mapId) {
		const mapEntry = mapEntryById(manifest, request.mapId);
		const position = tryParsePositionParameter(request.positionText);

		if (mapEntry && position) {
			return result(mapEntry, {
				type: "position",
				position,
			});
		}

		invalidLocationUrl = true;
	} else if (request.positionText) {
		invalidLocationUrl = true;
	}

	if (request.markerId) {
		const location = await markerLocation(manifest, request.markerId, request.mapId, signal);

		if (location) {
			return result(location.mapEntry, {
				type: "marker",
				markerId: location.marker.id,
			}, markerLocationUrl(location.mapEntry.id, location.marker.id));
		}

		invalidLocationUrl = true;
	}

	if (request.mapId) {
		const mapEntry = mapEntryById(manifest, request.mapId);

		if (mapEntry) {
			return result(mapEntry);
		}

		invalidLocationUrl = true;
	}

	return result(manifest.maps[0]);
}

function markerPinsForMap(map, locator) {
	const pins = (map.markers?.pins ?? []).map((pin) => ({
		...pin,
		mapId: map.id,
		markerType: "pin",
	}));

	if (locator?.type === "position") {
		pins.push({
			id: URL_POSITION_MARKER_ID,
			category: URL_POSITION_MARKER_ID,
			mapId: map.id,
			markerType: "position_marker",
			position: locator.position,
		});
	}

	return pins;
}

function clearMap() {
	loadedMap = null;
	mapRenderer.clear();
	markerOverlays.hidePopup();
	markerOverlays.hideTooltip();
	floorController.setMap(null);
	filters.setCurrentMap(null);
	filters.writeFilters(null);
	clearLoading();
}

async function loadMap(mapEntry, locator, signal) {
	setLoading(mapEntry);

	const map = await loadMapData(mapEntry, signal);
	const [glb, boundaryPaths, mainPathParts, terrainClipParts] = await Promise.all([
		loadGlb(map.file, signal),
		loadBoundaryPaths(map.boundaries, signal),
		loadGeometryParts(map.landmarks?.mainPath, signal),
		import.meta.env.DEV ? loadGeometryParts(map.diagnostics?.terrainClip, signal) : null,
	]);
	if (signal.aborted) return;
	const markerPins = markerPinsForMap(map, locator);

	loadedMap = {map, glb, boundaryPaths, mainPathParts, terrainClipParts, markerPins};
	filters.setCurrentMap(map);
	const renderedPins = renderMapView(false);
	const selectedMarker = locator?.type === "marker"
		? renderedPins.find((marker) => marker.id === locator.markerId && marker.markerType === "pin")
		: null;
	filters.writeFilters(map);
	clearLoading();
	if (locator?.type === "position") {
		await mapRenderer.centerOnPosition(locator.position, map.id);
	}
	if (selectedMarker) {
		if (await mapRenderer.centerOnPosition(selectedMarker.position, map.id)) {
			markerOverlays.showPopup(selectedMarker);
		}
	}
}

function renderMapView(keepView) {
	const {map, glb, boundaryPaths, mainPathParts, terrainClipParts, markerPins} = loadedMap;
	const reachable = isReachableView(map, showUnreachable);
	const navmesh = navmeshView(glb, map, reachable);
	const layers = viewLayers(map, reachable);
	const heightColors = createHeightColors(navmesh, layers.length);
	const renderedPins = viewPins(markerPins, reachable);

	mapRenderer.render(
		map,
		navmesh,
		reachable ? boundaryPaths.reach : boundaryPaths.all,
		geometryPartMeshes(mainPathParts, reachable, false),
		{
			keepView,
			heightColors: heightColors.colors,
			terrainClipMeshes: geometryPartMeshes(terrainClipParts, reachable, true),
			terrainClipVisible: import.meta.env.DEV && debugTerrainClippingVisible,
			mainPathVisible: filters.mainPathVisible,
			fitPositions: glb.positions,
			markerPins: renderedPins,
			visiblePinCategories: filters.visiblePinCategorySet(map),
			onMarkerClick: markerOverlays.showPopup,
			onMarkerHover: markerOverlays.showTooltip,
			onMapCoordinatePick: import.meta.env.DEV ? copyMapCoordinate : null,
			onViewChange: markerOverlays.update,
		},
	);
	floorController.setMap(map, heightColors.gradient, layers);
	return renderedPins;
}

async function loadLocationFromUrl(manifest) {
	loadController?.abort();
	const controller = new AbortController();
	loadController = controller;
	const {signal} = controller;
	clearMap();
	try {
		const request = readLocationRequest();
		const location = await resolveLocationRequest(manifest, request, signal);
		if (signal.aborted) return;

		mapSelect.value = location.mapEntry.id;
		if (location.canonicalUrl) {
			replaceUrl(location.canonicalUrl);
		}
		await loadMap(location.mapEntry, location.locator, signal);
	} catch (error) {
		if (signal.aborted) return;
		clearMap();
		showError(error);
	}
}

async function initialize() {
	const response = await fetch("./data/maps.json");

	if (!response.ok) {
		throw new Error(t("errorLoadingManifest", {status: response.status}));
	}

	const manifest = await response.json();

	if (!Array.isArray(manifest.maps) || manifest.maps.length === 0) {
		throw new Error(t("errorNoMaps"));
	}

	await loadGameText(manifest.gameText, manifest.markerLabels);
	currentManifest = manifest;
	writeMapOptions(mapSelect, manifest);
	writeDataUpdatedAt(manifest.dataUpdatedAtUnix);

	mapSelect.addEventListener("change", () => {
		const mapEntry = mapEntryById(manifest, mapSelect.value);

		pushUrl(mapLocationUrl(mapEntry.id));
		loadLocationFromUrl(manifest);
	});
	window.addEventListener("popstate", () => {
		loadLocationFromUrl(manifest);
	});

	await loadLocationFromUrl(manifest);
}

export function startApp() {
	createIcons({ icons: { Info, Menu, Settings, X } });
	applyTranslations();
	initializeAbout();
	initializeSettings(() => {
		applyTranslations();
		document.title = t("appTitle");
		renderChangelog();
		if (currentManifest) {
			const mapId = mapSelect.value;
			writeMapOptions(mapSelect, currentManifest);
			mapSelect.value = mapId;
			writeDataUpdatedAt(currentManifest.dataUpdatedAtUnix);
		}
		filters.refreshLabels();
		floorController.refreshLabels();
		markerOverlays.refreshLabels();
		if (loadingMap) setLoading(loadingMap);
	});
	document.title = t("appTitle");
	setPanelCollapsed(mobileMedia.matches);
	filters.initialize();
	mapElement.addEventListener("contextmenu", (event) => {
		event.preventDefault();
	});
	panelToggle.addEventListener("click", () => {
		setPanelCollapsed(!panel.classList.contains("collapsed"));
	});
	const showUnreachableInput = document.querySelector("#show-unreachable");
	showUnreachableInput.checked = showUnreachable;
	showUnreachableInput.addEventListener("change", () => {
		showUnreachable = showUnreachableInput.checked;
		writeStoredProperty(VIEW_STORAGE_KEY, "showUnreachable", showUnreachable);
		if (loadedMap) {
			markerOverlays.hidePopup();
			markerOverlays.hideTooltip();
			renderMapView(true);
		}
	});
	if (import.meta.env.DEV) {
		const debugTerrainClipping = document.querySelector("#debug-terrain-clipping");
		debugTerrainClipping.checked = debugTerrainClippingVisible;
		debugTerrainClipping.addEventListener("change", () => {
			debugTerrainClippingVisible = debugTerrainClipping.checked;
			writeDebugTerrainClippingVisible(debugTerrainClippingVisible);
			mapRenderer.setTerrainClipVisible(debugTerrainClippingVisible);
		});
	}
	markerPopupClose.addEventListener("click", markerOverlays.hidePopup);

	initialize().catch((error) => {
		clearLoading();
		showError(error);
	});
}
