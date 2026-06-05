import { parseGlb } from "./glb.js";
import { applyTranslations, localizeValue, t } from "./i18n.js";
import { createLandmarkMesh } from "./landmarks.js";
import { createBoundaryPaths } from "./boundaries.js";
import { APP_CONFIG } from "./config.js";
import { createMesh } from "./navmesh.js";
import { createMapRenderer } from "./renderer.js";
import { createFilterController } from "./filters.js";
import { createMarkerOverlays } from "./overlays.js";
import { mapTitle, writeMapOptions } from "./manifest.js";
import { createRotationControl } from "./joystick.js";
import { formatLocalTimestampFromUnix } from "./time.js";
import { createNotifications } from "./notifications.js";
import { createElement as createLucideElement, createIcons, Menu, Rotate3d, X } from "lucide";

const mapElement = document.querySelector("#map");
const mapSelect = document.querySelector("#map-select");
const loadingOverlay = document.querySelector("#loading-overlay");
const notificationsElement = document.querySelector("#notifications");
const panel = document.querySelector(".panel");
const panelToggle = document.querySelector("#panel-toggle");
const helpElement = document.querySelector("#help");
const filterList = document.querySelector("#filter-list");
const markerPopup = document.querySelector("#marker-popup");
const markerPopupTitle = document.querySelector("#marker-popup-title");
const markerPopupType = document.querySelector("#marker-popup-type");
const markerPopupDescription = document.querySelector("#marker-popup-description");
const markerPopupClose = document.querySelector("#marker-popup-close");
const markerTooltip = document.querySelector("#marker-tooltip");
const auxiliaryArrow = document.querySelector("#auxiliary-arrow");
const auxiliaryArrowArc = document.querySelector("#auxiliary-arrow-arc");
const auxiliaryArrowArcOutline = document.querySelector("#auxiliary-arrow-arc-outline");
const dataUpdatedElement = document.querySelector("#data-updated");
const rotationControl = document.querySelector("#rotation-control");
const rotationControlHandle = document.querySelector("#rotation-control-handle");
const mobileMedia = window.matchMedia(APP_CONFIG.ui.mobileMediaQuery);
const touchPrimaryMedia = window.matchMedia("(hover: none) and (pointer: coarse)");

let loadController;
let touchInputEnabled = shouldStartInTouchMode();
const notifications = createNotifications({
	container: notificationsElement,
	createIcon: () => createLucideElement(X, {"aria-hidden": "true"}),
	dismissLabel: () => t("dismiss"),
});

function formatBytes(bytes) {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	return `${(bytes / 1024).toFixed(1)} KB`;
}

function setLoading(message) {
	loadingOverlay.textContent = message;
	loadingOverlay.hidden = false;
}

function clearLoading() {
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

async function copyMarkerId(markerId) {
	await navigator.clipboard.writeText(markerId);
	showInfo(`Copied ID: ${markerId}`);
}

function formatCoordinate(position) {
	return `[${position.map((value) => Number(value.toFixed(3))).join(", ")}]`;
}

function copyMapCoordinate(position) {
	if (!position) {
		showWarning("No navmesh position picked.");
		return;
	}

	const text = formatCoordinate(position);

	navigator.clipboard.writeText(text)
		.then(() => showInfo(`Copied coordinate: ${text}`))
		.catch(showError);
}

function setPanelCollapsed(collapsed) {
	panel.classList.toggle("collapsed", collapsed);
	panelToggle.setAttribute("aria-expanded", String(!collapsed));
}

function writeHelp() {
	helpElement.textContent = touchInputEnabled
		? t("helpTouch")
		: t("helpDesktop");
}

function writeInputMode() {
	document.documentElement.classList.toggle("touch-input", touchInputEnabled);
	writeHelp();
}

function shouldStartInTouchMode() {
	return touchPrimaryMedia.matches || mobileMedia.matches;
}

function setTouchInputEnabled(enabled) {
	if (touchInputEnabled === enabled) {
		return;
	}

	touchInputEnabled = enabled;
	writeInputMode();
}

function updateInputModeFromPointer(event) {
	if (event.pointerType === "mouse") {
		setTouchInputEnabled(false);
		return;
	}

	if (event.pointerType === "touch" || event.pointerType === "pen") {
		setTouchInputEnabled(true);
	}
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
	return localizeValue(marker.name, categoryTitle(marker.category));
}

const mapRenderer = createMapRenderer(mapElement, showError);
const markerOverlays = createMarkerOverlays({
	markerPopup,
	markerPopupTitle,
	markerPopupType,
	markerPopupDescription,
	markerTooltip,
	auxiliaryArrow,
	auxiliaryArrowArc,
	auxiliaryArrowArcOutline,
	mapRenderer,
	categoryTitle,
	markerName,
	onCopyMarkerId: import.meta.env.DEV ? copyMarkerId : null,
	onCopyMarkerIdError: showError,
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

async function loadMainPathMeshes(mainPath, signal) {
	if (!mainPath) {
		return null;
	}

	const glb = await loadGlb(mainPath.file, signal);
	const meshes = {};

	for (const [part, partGlb] of Object.entries(glb.parts)) {
		meshes[part] = createLandmarkMesh(partGlb);
	}

	return meshes;
}

async function loadMapData(mapEntry, signal) {
	const response = await fetch(mapEntry.file, { signal });

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} while loading ${mapEntry.file}`);
	}

	const map = await response.json();

	if (map.id !== mapEntry.id) {
		throw new Error(`Map data id mismatch: ${mapEntry.file}. Expected ${mapEntry.id}, got ${map.id}.`);
	}

	return {
		...mapEntry,
		...map,
	};
}

async function loadMap(mapEntry) {
	if (loadController) {
		loadController.abort();
	}

	loadController = new AbortController();
	markerOverlays.hidePopup();
	markerOverlays.hideTooltip();
	setLoading(t("loadingMap", {
		title: mapTitle(mapEntry),
		size: formatBytes(mapEntry.resourceBytes),
	}));

	try {
		const map = await loadMapData(mapEntry, loadController.signal);
		const glb = await loadGlb(map.file, loadController.signal);
		const mainPathMeshes = await loadMainPathMeshes(map.landmarks?.mainPath, loadController.signal);

		filters.setCurrentMap(map);
		mapRenderer.render(
			map,
			createMesh(glb),
			createBoundaryPaths(glb),
			mainPathMeshes,
			{
				mainPathVisible: filters.mainPathVisible,
				fitPositions: glb.positions,
				markerPins: (map.markers?.pins ?? []).map((pin) => ({
					...pin,
					markerType: "pin",
				})),
				visiblePinCategories: filters.visiblePinCategorySet(map),
				onMarkerClick: markerOverlays.showPopup,
				onMarkerHover: markerOverlays.showTooltip,
				onMapCoordinatePick: import.meta.env.DEV ? copyMapCoordinate : null,
				onViewChange: markerOverlays.update,
			},
		);
		filters.writeFilters(map);
		clearLoading();
	} catch (error) {
		if (error.name !== "AbortError") {
			clearLoading();
			showError(error);
		}
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

	writeMapOptions(mapSelect, manifest);
	writeDataUpdatedAt(manifest.dataUpdatedAtUnix);

	mapSelect.addEventListener("change", () => {
		loadMap(manifest.maps.find((map) => map.id === mapSelect.value));
	});

	await loadMap(manifest.maps.find((map) => map.id === mapSelect.value));
}

export function startApp() {
	createIcons({ icons: { Menu, Rotate3d, X } });
	applyTranslations();
	document.title = t("appTitle");
	document.documentElement.classList.toggle("dev-tools", import.meta.env.DEV);
	setPanelCollapsed(mobileMedia.matches);
	writeInputMode();
	filters.initialize();
	createRotationControl({
		root: rotationControl,
		handle: rotationControlHandle,
		mapRenderer,
	});
	window.addEventListener("pointerdown", updateInputModeFromPointer, { capture: true });
	mapElement.addEventListener("contextmenu", (event) => {
		event.preventDefault();
	});
	panelToggle.addEventListener("click", () => {
		setPanelCollapsed(!panel.classList.contains("collapsed"));
	});
	markerPopupClose.addEventListener("click", markerOverlays.hidePopup);

	initialize().catch((error) => {
		clearLoading();
		showError(error);
	});
}
