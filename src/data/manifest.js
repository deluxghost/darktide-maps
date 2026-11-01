import { language, localizeValue, t } from "../i18n.js";
import { APP_CONFIG } from "../config.js";

const nameOrder = new Intl.Collator("en", {numeric: true, sensitivity: "base"});

export function mapTitle(map, locale = language) {
	return localizeValue(map.title, map.id, locale);
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
	mapSelect.replaceChildren();
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
		.sort((left, right) => nameOrder.compare(
			localizeValue(zones[left], left, "en"), localizeValue(zones[right], right, "en"),
		) || nameOrder.compare(left, right));

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
		for (const map of [...maps].sort((left, right) => nameOrder.compare(mapTitle(left, "en"), mapTitle(right, "en"))
			|| nameOrder.compare(left.id, right.id))) {
			appendMapOption(group, map);
		}
		mapSelect.append(group);
	}
}
