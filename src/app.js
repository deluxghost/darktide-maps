import { parseGlb } from "./glb.js";
import { applyTranslations, t } from "./i18n.js";
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

let loadController;
let mainPathVisible = true;

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
	option.textContent = map.title ?? map.id;
	parent.append(option);
}

function writeMapOptions(manifest) {
	const regions = new Map((manifest.regions ?? []).map((region) => [region.id, region]));
	const groupedMaps = new Map();

	for (const map of manifest.maps) {
		const maps = groupedMaps.get(map.regionId);

		if (maps) {
			maps.push(map);
		} else {
			groupedMaps.set(map.regionId, [map]);
		}
	}

	for (const [regionId, maps] of groupedMaps) {
		const region = regions.get(regionId);

		if (!region) {
			for (const map of maps) {
				appendMapOption(mapSelect, map);
			}

			continue;
		}

		const group = document.createElement("optgroup");

		group.label = region.title ?? region.id;
		for (const map of maps) {
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
		title: map.title ?? map.id,
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
			{mainPathVisible},
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

	await loadMap(manifest.maps[0]);
}

export function startApp() {
	createIcons({ icons: { Menu } });
	applyTranslations();
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
