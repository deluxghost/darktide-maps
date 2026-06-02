import { parseGlb } from "./glb.js";
import { applyTranslations, localizeValue, t } from "./i18n.js";
import { createLandmarkMesh } from "./landmarks.js";
import { createBoundaryPaths } from "./boundaries.js";
import { VISUAL_CONFIG } from "./config.js";
import { createMesh } from "./navmesh.js";
import { createMapRenderer } from "./renderer.js";
import { createIcons, Menu, X } from "lucide";

const mapElement = document.querySelector("#map");
const mapSelect = document.querySelector("#map-select");
const loadingOverlay = document.querySelector("#loading-overlay");
const errorBanner = document.querySelector("#error-banner");
const errorMessageElement = document.querySelector("#error-message");
const errorDismiss = document.querySelector("#error-dismiss");
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
const mobileMedia = window.matchMedia("(max-width: 640px)");
const trailingZoneIds = ["operations", "other"];

let loadController;
let mainPathVisible = true;
let activeMarker = null;
let activeTooltipMarker = null;
const pinCategoryVisibility = new Map();

function mapTitle(map) {
	return localizeValue(map.title, map.id);
}

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
	errorMessageElement.textContent = error.message;
	errorBanner.hidden = false;
	console.error(error);
}

function setPanelCollapsed(collapsed) {
	panel.classList.toggle("collapsed", collapsed);
	panelToggle.setAttribute("aria-expanded", String(!collapsed));
}

function writeHelp() {
	helpElement.textContent = mobileMedia.matches
		? t("helpMobile")
		: t("helpDesktop");
}

function writeEmptyFilters() {
	filterList.replaceChildren();

	const message = document.createElement("p");

	message.className = "muted";
	message.textContent = t("noMarkerCategories");
	filterList.append(message);
}

function categoryTitle(category) {
	const labelKey = VISUAL_CONFIG.runtime.pins.categories[category]?.labelKey;

	return labelKey ? t(labelKey) : category;
}

function markerName(marker) {
	return localizeValue(marker.name, categoryTitle(marker.category));
}

function colorStyle(color) {
	return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function createFilterOption(checked, labelText, color, onChange) {
	const label = document.createElement("label");
	const checkbox = document.createElement("input");
	const swatch = document.createElement("span");
	const text = document.createElement("span");

	label.className = "filter-option";
	checkbox.type = "checkbox";
	checkbox.checked = checked;
	swatch.className = "filter-color";
	swatch.style.background = colorStyle(color);
	text.textContent = labelText;
	checkbox.addEventListener("change", () => onChange(checkbox.checked));
	label.append(checkbox, swatch, text);

	return label;
}

function markerCategories(map) {
	return [...new Set((map.markers?.pins ?? []).map((pin) => pin.category))]
		.sort((left, right) => left.localeCompare(right));
}

function isPinCategoryVisible(category) {
	return pinCategoryVisibility.get(category) ?? true;
}

function visiblePinCategorySet(map) {
	return new Set(markerCategories(map).filter(isPinCategoryVisible));
}

function writeFilters(map) {
	filterList.replaceChildren();

	if (map.landmarks?.mainPath) {
		filterList.append(createFilterOption(
			mainPathVisible,
			t("filterMainPath"),
			VISUAL_CONFIG.runtime.mainPath.tubeColor,
			(visible) => {
				mainPathVisible = visible;
				mapRenderer.setMainPathVisible(visible);
			},
		));
	}

	for (const category of markerCategories(map)) {
		const config = VISUAL_CONFIG.runtime.pins.categories[category];

		if (!config) {
			continue;
		}

		filterList.append(createFilterOption(
			isPinCategoryVisible(category),
			categoryTitle(category),
			config.color,
			(visible) => {
				pinCategoryVisibility.set(category, visible);
				mapRenderer.setPinCategoryVisible(category, visible);

				if (!visible && activeMarker?.category === category) {
					hideMarkerPopup();
				}

				if (!visible && activeTooltipMarker?.category === category) {
					hideMarkerTooltip();
				}
			},
		));
	}

	if (filterList.children.length === 0) {
		writeEmptyFilters();
	}
}

function appendMapOption(parent, map) {
	const option = document.createElement("option");

	option.value = map.id;
	option.textContent = mapTitle(map);
	parent.append(option);
}

function zoneTitle(zoneId, title) {
	if (zoneId === "other") {
		return t("zoneOther");
	}

	return localizeValue(title, zoneId);
}

function writeMapOptions(manifest) {
	const zones = manifest.zones ?? {};
	const groupedMaps = new Map();

	for (const map of manifest.maps) {
		const zone = map.zone ?? "other";
		const maps = groupedMaps.get(zone);

		if (maps) {
			maps.push(map);
		} else {
			groupedMaps.set(zone, [map]);
		}
	}

	const zoneIds = [...groupedMaps.keys()]
		.filter((zone) => !trailingZoneIds.includes(zone))
		.sort((left, right) => left.localeCompare(right));

	for (const zone of trailingZoneIds) {
		if (groupedMaps.has(zone)) {
			zoneIds.push(zone);
		}
	}

	for (const zone of zoneIds) {
		const maps = groupedMaps.get(zone);

		if (!maps) {
			continue;
		}

		const group = document.createElement("optgroup");

		group.label = zoneTitle(zone, zones[zone]);
		for (const map of [...maps].sort((left, right) => left.id.localeCompare(right.id))) {
			appendMapOption(group, map);
		}
		mapSelect.append(group);
	}
}

const mapRenderer = createMapRenderer(mapElement, showError);

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

function hideMarkerPopup() {
	activeMarker = null;
	markerPopup.hidden = true;
}

function hideMarkerTooltip() {
	activeTooltipMarker = null;
	markerTooltip.hidden = true;
}

function updateMarkerPopupPosition() {
	if (!activeMarker || markerPopup.hidden) {
		return;
	}

	const point = mapRenderer.projectPosition(activeMarker.position);

	if (!point) {
		return;
	}

	markerPopup.style.left = `${point.x}px`;
	markerPopup.style.top = `${point.y}px`;
}

function updateMarkerTooltipPosition() {
	if (!activeTooltipMarker || markerTooltip.hidden) {
		return;
	}

	const point = mapRenderer.projectPosition(activeTooltipMarker.position);

	if (!point) {
		return;
	}

	const [offsetX, offsetY] = VISUAL_CONFIG.runtime.pins.tooltipOffset;

	markerTooltip.style.left = `${point.x + offsetX}px`;
	markerTooltip.style.top = `${point.y + offsetY}px`;
}

function updateMarkerOverlays() {
	updateMarkerPopupPosition();
	updateMarkerTooltipPosition();
}

function showMarkerPopup(marker) {
	if (!marker) {
		hideMarkerPopup();

		return;
	}

	activeMarker = marker;
	markerPopupTitle.textContent = markerName(marker);
	markerPopupType.textContent = categoryTitle(marker.category);
	markerPopupDescription.textContent = marker.description
		? localizeValue(marker.description, "")
		: t("markerNoDescription");
	markerPopup.hidden = false;
	updateMarkerPopupPosition();
}

function showMarkerTooltip(marker) {
	if (!marker) {
		hideMarkerTooltip();

		return;
	}

	activeTooltipMarker = marker;
	markerTooltip.textContent = markerName(marker);
	markerTooltip.hidden = false;
	updateMarkerTooltipPosition();
}

async function loadMap(map) {
	if (loadController) {
		loadController.abort();
	}

	loadController = new AbortController();
	errorBanner.hidden = true;
	hideMarkerPopup();
	hideMarkerTooltip();
	setLoading(t("loadingMap", {
		title: mapTitle(map),
		size: formatBytes(map.assetBytes),
	}));

	try {
		const glb = await loadGlb(map.file, loadController.signal);
		const mainPathMeshes = await loadMainPathMeshes(map.landmarks?.mainPath, loadController.signal);

		mapRenderer.render(
			map,
			createMesh(glb),
			createBoundaryPaths(glb),
			mainPathMeshes,
			{
				mainPathVisible,
				fitPositions: glb.positions,
				markerPins: (map.markers?.pins ?? []).map((pin) => ({
					...pin,
					markerType: "pin",
				})),
				visiblePinCategories: visiblePinCategorySet(map),
				onMarkerClick: showMarkerPopup,
				onMarkerHover: showMarkerTooltip,
				onViewChange: updateMarkerOverlays,
			},
		);
		writeFilters(map);
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

	writeMapOptions(manifest);

	mapSelect.addEventListener("change", () => {
		loadMap(manifest.maps.find((map) => map.id === mapSelect.value));
	});

	await loadMap(manifest.maps.find((map) => map.id === mapSelect.value));
}

export function startApp() {
	createIcons({ icons: { Menu, X } });
	applyTranslations();
	document.title = t("appTitle");
	setPanelCollapsed(mobileMedia.matches);
	writeHelp();
	mobileMedia.addEventListener("change", writeHelp);
	mapElement.addEventListener("contextmenu", (event) => {
		event.preventDefault();
	});
	panelToggle.addEventListener("click", () => {
		setPanelCollapsed(!panel.classList.contains("collapsed"));
	});
	errorDismiss.addEventListener("click", () => {
		errorBanner.hidden = true;
	});
	markerPopupClose.addEventListener("click", hideMarkerPopup);

	initialize().catch((error) => {
		clearLoading();
		showError(error);
	});
}
