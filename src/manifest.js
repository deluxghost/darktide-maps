import { localizeValue, t } from "./i18n.js";
import { APP_CONFIG } from "./config.js";

export function mapTitle(map) {
	return localizeValue(map.title, map.id);
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

export function writeMapOptions(mapSelect, manifest) {
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
