import { parseGlb } from "./glb.js";
import { applyTranslations, localizeValue, t } from "./i18n.js";
import { createLandmarkMesh } from "./landmarks.js";
import { createBoundaryPaths } from "./boundaries.js";
import { APP_CONFIG } from "./config.js";
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
const dataUpdatedElement = document.querySelector("#data-updated");
const mobileMedia = window.matchMedia(APP_CONFIG.ui.mobileMediaQuery);
const FILTER_STORAGE_KEY = "darktide-maps.filterVisibility.v1";
const MAIN_PATH_FILTER_ID = "main_path";
const FILTER_GROUPS = [
	{
		labelKey: "filterGroupMission",
		items: [MAIN_PATH_FILTER_ID],
	},
	{
		labelKey: "filterGroupTeam",
		items: ["health_station", "respawn_point"],
	},
	{
		labelKey: "filterGroupEnemies",
		items: ["boss_spawn", "daemonhost", "havoc_boss_spawn"],
	},
	{
		labelKey: "filterGroupResources",
		items: ["chest", "supply_spawn", "side_mission_spawn"],
	},
];
const DEFAULT_HIDDEN_FILTER_ITEMS = new Set([
	"chest",
	"supply_spawn",
	"side_mission_spawn",
]);
const ALL_FILTER_ITEM_IDS = FILTER_GROUPS.flatMap((group) => group.items);

let loadController;
let mainPathVisible = true;
let currentMap = null;
let activeMarker = null;
let activeTooltipMarker = null;
const pinCategoryVisibility = new Map();
const storedFilterVisibility = loadFilterVisibility();

function loadFilterVisibility() {
	const visibility = Object.fromEntries(ALL_FILTER_ITEM_IDS.map((itemId) => [
		itemId,
		!DEFAULT_HIDDEN_FILTER_ITEMS.has(itemId),
	]));

	try {
		const stored = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? "{}");

		if (stored && typeof stored === "object") {
			for (const itemId of ALL_FILTER_ITEM_IDS) {
				if (itemId in stored) {
					visibility[itemId] = Boolean(stored[itemId]);
				}
			}
		}
	} catch {
		console.warn("Ignoring invalid filter visibility storage.");
	}

	localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(visibility));

	return visibility;
}

function saveFilterVisibilityValue(itemId, visible) {
	storedFilterVisibility[itemId] = visible;
	localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(storedFilterVisibility));
}

function saveFilterVisibility() {
	localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(storedFilterVisibility));
}

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

function writeDataUpdatedAt(value) {
	dataUpdatedElement.hidden = !value;
	dataUpdatedElement.textContent = value
		? t("dataUpdatedAt", {time: value})
		: "";
}

function writeEmptyFilters() {
	filterList.replaceChildren();

	const message = document.createElement("p");

	message.className = "muted";
	message.textContent = t("noMarkerCategories");
	filterList.append(message);
}

function categoryTitle(category) {
	const labelKey = APP_CONFIG.runtime.visual.pins.categories[category]?.labelKey;

	return labelKey ? t(labelKey) : category;
}

function markerName(marker) {
	return localizeValue(marker.name, categoryTitle(marker.category));
}

function colorStyle(color) {
	return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function filterItemLabel(itemId) {
	if (itemId === MAIN_PATH_FILTER_ID) {
		return t("filterMainPath");
	}

	return categoryTitle(itemId);
}

function filterItemColor(itemId) {
	if (itemId === MAIN_PATH_FILTER_ID) {
		return APP_CONFIG.runtime.visual.mainPath.tubeColor;
	}

	return APP_CONFIG.runtime.visual.pins.categories[itemId]?.color;
}

function createFilterItem(item, visible, onClick) {
	const button = document.createElement("button");
	const swatch = document.createElement("span");
	const text = document.createElement("span");
	const count = document.createElement("span");

	button.className = "filter-item";
	button.type = "button";
	button.title = item.label;
	button.setAttribute("aria-pressed", String(visible));
	button.classList.toggle("disabled", !visible);
	swatch.className = "filter-color";
	text.className = "filter-label";
	count.className = "filter-count";
	swatch.style.background = colorStyle(item.color);
	text.textContent = item.label;
	count.textContent = item.count;
	button.addEventListener("click", onClick);
	button.append(swatch, text, count);

	return button;
}

function markerCategories(map) {
	const categories = new Set((map.markers?.pins ?? []).map((pin) => pin.category));
	const orderedCategories = FILTER_GROUPS
		.flatMap((group) => group.items)
		.filter((itemId) => itemId !== MAIN_PATH_FILTER_ID && categories.has(itemId));

	for (const category of categories) {
		if (!orderedCategories.includes(category)) {
			orderedCategories.push(category);
		}
	}

	return orderedCategories;
}

function isPinCategoryVisible(category) {
	return pinCategoryVisibility.get(category) ?? true;
}

function visiblePinCategorySet(map) {
	return new Set(markerCategories(map).filter(isPinCategoryVisible));
}

function setPinCategoryVisible(category, visible) {
	pinCategoryVisibility.set(category, visible);
	mapRenderer.setPinCategoryVisible(category, visible);

	if (!visible && activeMarker?.category === category) {
		hideMarkerPopup();
	}

	if (!visible && activeTooltipMarker?.category === category) {
		hideMarkerTooltip();
	}
}

function setFilterItemVisible(itemId, visible) {
	applyFilterItemVisibility(itemId, visible);
	saveFilterVisibilityValue(itemId, visible);
	writeFilters(currentMap);
}

function applyFilterItemVisibility(itemId, visible) {
	if (itemId === MAIN_PATH_FILTER_ID) {
		mainPathVisible = visible;
		mapRenderer.setMainPathVisible(visible);
	} else {
		setPinCategoryVisible(itemId, visible);
	}
}

function setVisibleFilterItemsVisible(items, visible) {
	for (const item of items) {
		if (item.visible !== visible) {
			applyFilterItemVisibility(item.id, visible);
			saveFilterVisibilityValue(item.id, visible);
		}
	}

	writeFilters(currentMap);
}

function setAllFilterItemsVisible(visible) {
	for (const itemId of ALL_FILTER_ITEM_IDS) {
		storedFilterVisibility[itemId] = visible;
	}

	saveFilterVisibility();
	mainPathVisible = storedFilterVisibility[MAIN_PATH_FILTER_ID];
	for (const category of Object.keys(APP_CONFIG.runtime.visual.pins.categories)) {
		const categoryVisible = storedFilterVisibility[category] ?? true;

		pinCategoryVisibility.set(category, categoryVisible);
		mapRenderer.setPinCategoryVisible(category, categoryVisible);
	}
	mapRenderer.setMainPathVisible(mainPathVisible);

	if (activeMarker && !isPinCategoryVisible(activeMarker.category)) {
		hideMarkerPopup();
	}

	if (activeTooltipMarker && !isPinCategoryVisible(activeTooltipMarker.category)) {
		hideMarkerTooltip();
	}

	writeFilters(currentMap);
}

function markerCounts(map) {
	const counts = new Map();

	for (const pin of map.markers?.pins ?? []) {
		counts.set(pin.category, (counts.get(pin.category) ?? 0) + 1);
	}

	return counts;
}

function filterItemsForMap(map) {
	const counts = markerCounts(map);

	return FILTER_GROUPS.map((group) => ({
		...group,
		items: group.items
			.map((itemId) => {
				const count = itemId === MAIN_PATH_FILTER_ID
					? map.landmarks?.mainPath ? 1 : 0
					: counts.get(itemId) ?? 0;
				const color = filterItemColor(itemId);

				if (count <= 0 || !color) {
					return null;
				}

				return {
					id: itemId,
					label: filterItemLabel(itemId),
					color,
					count,
					visible: itemId === MAIN_PATH_FILTER_ID
						? mainPathVisible
						: isPinCategoryVisible(itemId),
				};
			})
			.filter(Boolean),
	})).filter((group) => group.items.length > 0);
}

function createFilterToolbar(map) {
	const toolbar = document.createElement("div");
	const showAll = document.createElement("button");
	const hideAll = document.createElement("button");

	toolbar.className = "filter-toolbar";
	showAll.type = "button";
	showAll.textContent = t("filterShowAll");
	showAll.title = t("filterShowAll");
	showAll.addEventListener("click", () => setAllFilterItemsVisible(true));
	hideAll.type = "button";
	hideAll.textContent = t("filterHideAll");
	hideAll.title = t("filterHideAll");
	hideAll.addEventListener("click", () => setAllFilterItemsVisible(false));
	toolbar.append(showAll, hideAll);

	return toolbar;
}

function createFilterGroup(group) {
	const section = document.createElement("section");
	const title = document.createElement("button");
	const grid = document.createElement("div");
	const groupVisible = group.items.some((item) => item.visible);

	section.className = "filter-group";
	title.className = "filter-group-title";
	title.type = "button";
	title.textContent = t(group.labelKey);
	title.title = t(group.labelKey);
	title.setAttribute("aria-pressed", String(groupVisible));
	title.addEventListener("click", () => {
		setVisibleFilterItemsVisible(group.items, !groupVisible);
	});
	grid.className = "filter-grid";

	for (const item of group.items) {
		grid.append(createFilterItem(item, item.visible, () => {
			setFilterItemVisible(item.id, !item.visible);
		}));
	}

	section.append(title, grid);

	return section;
}

function writeFilters(map) {
	filterList.replaceChildren();

	if (!map) {
		writeEmptyFilters();

		return;
	}

	const groups = filterItemsForMap(map);

	if (groups.length > 0) {
		filterList.append(createFilterToolbar(map));
		for (const group of groups) {
			filterList.append(createFilterGroup(group));
		}
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
		.filter((zone) => !APP_CONFIG.ui.trailingZoneIds.includes(zone))
		.sort((left, right) => left.localeCompare(right));

	for (const zone of APP_CONFIG.ui.trailingZoneIds) {
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

	const [offsetX, offsetY] = APP_CONFIG.runtime.visual.pins.tooltipOffset;

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
	markerPopupDescription.hidden = !marker.description;
	markerPopupDescription.textContent = marker.description
		? localizeValue(marker.description, "")
		: "";
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
	currentMap = map;
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
	writeDataUpdatedAt(manifest.dataUpdatedAt);

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
	mainPathVisible = storedFilterVisibility[MAIN_PATH_FILTER_ID] ?? true;
	for (const category of Object.keys(APP_CONFIG.runtime.visual.pins.categories)) {
		if (category in storedFilterVisibility) {
			pinCategoryVisibility.set(category, Boolean(storedFilterVisibility[category]));
		}
	}
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
