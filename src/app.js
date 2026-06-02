import { parseGlb } from "./glb.js";
import { applyTranslations, localizeValue, t } from "./i18n.js";
import { createLandmarkMesh } from "./landmarks.js";
import { createBoundaryPaths } from "./boundaries.js";
import { createMesh } from "./navmesh.js";
import { createMapRenderer } from "./renderer.js";
import { createIcons, Menu } from "lucide";

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
const mobileMedia = window.matchMedia("(max-width: 640px)");
const trailingZoneIds = ["operations", "other"];

let loadController;
let mainPathVisible = true;

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

function writeMainPathFilter(map) {
	filterList.replaceChildren();

	if (!map.landmarks?.mainPath) {
		writeEmptyFilters();

		return;
	}

	const label = document.createElement("label");
	const checkbox = document.createElement("input");
	const text = document.createElement("span");

	label.className = "filter-option";
	checkbox.type = "checkbox";
	checkbox.checked = mainPathVisible;
	text.textContent = t("filterMainPath");
	checkbox.addEventListener("change", () => {
		mainPathVisible = checkbox.checked;
		mapRenderer.setMainPathVisible(mainPathVisible);
	});
	label.append(checkbox, text);
	filterList.append(label);
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

async function loadMap(map) {
	if (loadController) {
		loadController.abort();
	}

	loadController = new AbortController();
	errorBanner.hidden = true;
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
			},
		);
		writeMainPathFilter(map);
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
	createIcons({ icons: { Menu } });
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

	initialize().catch((error) => {
		clearLoading();
		showError(error);
	});
}
