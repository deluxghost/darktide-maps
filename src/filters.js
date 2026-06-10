import { t } from "./i18n.js";
import { APP_CONFIG } from "./config.js";
import { readStoredObject, writeStoredObject } from "./storage.js";

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
		items: ["chest", "supply_spawn"],
	},
	{
		labelKey: "filterGroupCollectibles",
		items: ["scripture_spawn", "grimoire_spawn"],
	},
];
const DEFAULT_HIDDEN_FILTER_ITEMS = new Set([
	"chest",
	"supply_spawn",
	"scripture_spawn",
	"grimoire_spawn",
]);
const ALL_FILTER_ITEM_IDS = FILTER_GROUPS.flatMap((group) => group.items);

function colorStyle(color) {
	return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function loadFilterVisibility() {
	const visibility = Object.fromEntries(ALL_FILTER_ITEM_IDS.map((itemId) => [
		itemId,
		!DEFAULT_HIDDEN_FILTER_ITEMS.has(itemId),
	]));

	try {
		const stored = readStoredObject(FILTER_STORAGE_KEY);

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

	writeStoredObject(FILTER_STORAGE_KEY, visibility);

	return visibility;
}

export function createFilterController({
	filterList,
	mapRenderer,
	categoryTitle,
	onCategoryHidden,
}) {
	const pinCategoryVisibility = new Map();
	const storedFilterVisibility = loadFilterVisibility();
	let currentMap = null;
	let mainPathVisible = storedFilterVisibility[MAIN_PATH_FILTER_ID] ?? true;

	function saveFilterVisibilityValue(itemId, visible) {
		storedFilterVisibility[itemId] = visible;
		writeStoredObject(FILTER_STORAGE_KEY, storedFilterVisibility);
	}

	function saveFilterVisibility() {
		writeStoredObject(FILTER_STORAGE_KEY, storedFilterVisibility);
	}

	function writeEmptyFilters() {
		filterList.replaceChildren();

		const message = document.createElement("p");

		message.className = "muted";
		message.textContent = t("noMarkerCategories");
		filterList.append(message);
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

	function setPinCategoryVisible(category, visible) {
		pinCategoryVisibility.set(category, visible);
		mapRenderer.setPinCategoryVisible(category, visible);

		if (!visible) {
			onCategoryHidden(category);
		}
	}

	function applyFilterItemVisibility(itemId, visible) {
		if (itemId === MAIN_PATH_FILTER_ID) {
			mainPathVisible = visible;
			mapRenderer.setMainPathVisible(visible);
		} else {
			setPinCategoryVisible(itemId, visible);
		}
	}

	function setFilterItemVisible(itemId, visible) {
		applyFilterItemVisibility(itemId, visible);
		saveFilterVisibilityValue(itemId, visible);
		writeFilters(currentMap);
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
			if (!categoryVisible) {
				onCategoryHidden(category);
			}
		}
		mapRenderer.setMainPathVisible(mainPathVisible);

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

	function createFilterToolbar() {
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
			filterList.append(createFilterToolbar());
			for (const group of groups) {
				filterList.append(createFilterGroup(group));
			}
		}

		if (filterList.children.length === 0) {
			writeEmptyFilters();
		}
	}

	function visiblePinCategorySet(map) {
		return new Set(markerCategories(map).filter(isPinCategoryVisible));
	}

	function initialize() {
		for (const category of Object.keys(APP_CONFIG.runtime.visual.pins.categories)) {
			if (category in storedFilterVisibility) {
				pinCategoryVisibility.set(category, Boolean(storedFilterVisibility[category]));
			}
		}
	}

	function setCurrentMap(map) {
		currentMap = map;
	}

	return {
		initialize,
		setCurrentMap,
		visiblePinCategorySet,
		writeFilters,
		get mainPathVisible() {
			return mainPathVisible;
		},
	};
}
