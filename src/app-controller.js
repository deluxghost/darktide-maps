import { parseGlb } from "./glb.js";
import { createBoundaryPaths } from "./boundary-edges.js";
import { createMesh } from "./navmesh.js";
import { createNavmeshRenderer } from "./render-navmesh.js";
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
const mobileMedia = window.matchMedia("(max-width: 640px)");

let loadController;

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
		? "Drag to pan. Pinch to zoom. Twist or use three fingers to rotate."
		: "Drag to pan. Right-drag or Shift + drag to rotate. Scroll to zoom.";
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

const renderNavmesh = createNavmeshRenderer(mapElement, showError);

async function loadMap(map) {
	if (loadController) {
		loadController.abort();
	}

	loadController = new AbortController();
	errorBanner.hidden = true;
	setLoading(`Loading ${map.title ?? map.id} (${formatBytes(map.assetBytes)})...`);

	try {
		const response = await fetch(map.file, { signal: loadController.signal });

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} while loading ${map.file}`);
		}

		const glb = parseGlb(await response.arrayBuffer());

		renderNavmesh(map, createMesh(glb), createBoundaryPaths(glb));
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
		throw new Error(`HTTP ${response.status} while loading map manifest.`);
	}

	const manifest = await response.json();

	if (!Array.isArray(manifest.maps) || manifest.maps.length === 0) {
		throw new Error("Map manifest contains no maps.");
	}

	writeMapOptions(manifest);

	mapSelect.addEventListener("change", () => {
		loadMap(manifest.maps.find((map) => map.id === mapSelect.value));
	});

	await loadMap(manifest.maps[0]);
}

export function startApp() {
	createIcons({ icons: { Menu } });
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
