import assert from "node:assert/strict";
import markerConfig from "../../../config/markers.json" with {type: "json"};
import overrides from "../../../config/marker-overrides.json" with {type: "json"};
import translations from "../../../src/translations.json" with {type: "json"};

function object(value, label) {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: expected an object`);
}

function fields(value, allowed, label) {
	object(value, label);
	for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `${label}: unknown field ${key}`);
}

function textKey(key) {
	assert.ok(typeof key === "string" && key.length > 0, "Invalid translation key");
	for (const [locale, values] of Object.entries(translations)) {
		assert.equal(typeof values[key], "string", `Missing ${locale} translation: ${key}`);
	}
}

function text(value, label) {
	if (value === null || typeof value === "string") return;
	assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: invalid text`);
	if (Object.hasOwn(value, "key")) {
		fields(value, ["key", "values"], label);
		textKey(value.key);
		if (value.values) {
			object(value.values, label + ".values");
			for (const entry of Object.values(value.values)) assert.ok(typeof entry === "string" || Number.isFinite(entry), `${label}: invalid format value`);
		}
		return;
	}
	assert.equal(typeof value.en, "string", `${label}: localized text needs en`);
	for (const entry of Object.values(value)) assert.equal(typeof entry, "string", `${label}: invalid localized text`);
}

function configuredText(value, label) {
	for (const key of ["name", "description"]) {
		if (!Object.hasOwn(value, key) || value[key] === null) continue;
		fields(value[key], ["key", "values"], `${label}.${key}`);
		textKey(value[key].key);
	}
	for (const auxiliary of value.auxiliaryMarkers ?? []) configuredText(auxiliary, `${label}.${auxiliary.id}`);
}

function category(value) {
	assert.ok(Object.hasOwn(markerConfig.categories, value), `Unknown marker category: ${value}`);
}

function patch(value, label, auxiliary = false) {
	fields(value, ["name", "category", "position", ...(auxiliary ? ["direction"] : ["description", "auxiliaryMarkers"])], label);
	for (const key of ["name", "description"]) if (Object.hasOwn(value, key)) text(value[key], `${label}.${key}`);
	if (Object.hasOwn(value, "category")) category(value.category);
	if (Object.hasOwn(value, "position")) {
		assert.ok(Array.isArray(value.position) && value.position.length === 3 && value.position.every(Number.isFinite), `${label}: invalid position`);
	}
	if (Object.hasOwn(value, "direction")) assert.ok(["to_parent", "from_parent"].includes(value.direction), `${label}: invalid direction`);
	if (Object.hasOwn(value, "auxiliaryMarkers")) {
		assert.ok(Array.isArray(value.auxiliaryMarkers), `${label}: auxiliaryMarkers must be an array`);
		value.auxiliaryMarkers.forEach((entry) => marker(entry, true));
	}
}

function marker(value, auxiliary = false) {
	const {id, ...properties} = value;
	assert.match(id, /^[A-Za-z0-9_-]+$/, "Invalid marker id");
	patch(properties, id, auxiliary);
	assert.ok(Object.hasOwn(properties, "position"), `${id}: missing position`);
	if (!auxiliary) category(properties.category);
}

function markerIndex(pins) {
	const result = new Map();
	for (const pin of pins) {
		for (const entry of [pin, ...(pin.auxiliaryMarkers ?? [])]) {
			assert.ok(!result.has(entry.id), `Duplicate marker id: ${entry.id}`);
			result.set(entry.id, entry);
		}
	}
	return result;
}

function mapPolicy(mission, policy) {
	assert.match(mission, /^[A-Za-z0-9_-]+$/, "Invalid override map id");
	fields(policy, ["add", "override", "exclude", "relations"], mission);
	for (const key of ["add", "exclude", "relations"]) if (Object.hasOwn(policy, key)) assert.ok(Array.isArray(policy[key]), `${mission}.${key}: expected an array`);
	for (const entry of policy.add ?? []) {
		marker(entry);
		configuredText(entry, `${mission}.${entry.id}`);
	}
	for (const id of policy.exclude ?? []) assert.match(id, /^[A-Za-z0-9_-]+$/, `${mission}: invalid excluded id`);
	assert.equal(new Set(policy.exclude ?? []).size, (policy.exclude ?? []).length, `${mission}: duplicate exclusion`);
	if (!Object.hasOwn(policy, "override")) return;
	object(policy.override, mission + ".override");
	for (const [id, value] of Object.entries(policy.override)) {
		patch(value, `${mission}.${id}`, Object.hasOwn(value, "direction"));
		configuredText(value, `${mission}.${id}`);
	}
}

export function validateMarkerConfiguration(missionIds) {
	fields(markerConfig, ["groups", "defaultHidden", "categories", "families", "extraction", "explosiveShapes",
		"sourcePolicies", "omittedFamilies", "scriptedBossSources"], "marker configuration");
	const filterIds = new Set(["main_path", ...Object.keys(markerConfig.categories)]);
	const grouped = markerConfig.groups.flatMap((group) => {
		fields(group, ["labelKey", "items"], "filter group");
		textKey(group.labelKey);
		return group.items;
	});
	assert.equal(new Set(grouped).size, grouped.length, "Repeated filter item");
	assert.deepEqual(new Set(grouped), filterIds, "Every marker category must occur in one filter group");
	for (const id of markerConfig.defaultHidden) assert.ok(filterIds.has(id), `Unknown default-hidden filter: ${id}`);
	assert.equal(new Set(markerConfig.defaultHidden).size, markerConfig.defaultHidden.length, "Repeated default-hidden filter");
	for (const [id, value] of Object.entries(markerConfig.categories)) {
		fields(value, ["labelKey", "descriptionKey", "color"], id);
		textKey(value.labelKey);
		if (Object.hasOwn(value, "descriptionKey")) textKey(value.descriptionKey);
		assert.ok(Array.isArray(value.color) && value.color.length === 4
			&& value.color.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255), `${id}: invalid RGBA color`);
	}
	for (const [id, value] of Object.entries(markerConfig.families)) {
		fields(value, ["category", "source", "nameKey", "descriptionKey", "stackNameKey", "mergeHorizontalDistance", "mergeVerticalDistance",
			"mergeBy", "sourceKey", "distributions", "pickupGroups", "pickupType", "auxiliary"], id);
		category(value.category);
		if (Object.hasOwn(value, "nameKey")) textKey(value.nameKey);
		if (Object.hasOwn(value, "descriptionKey")) textKey(value.descriptionKey);
		if (Object.hasOwn(value, "stackNameKey")) textKey(value.stackNameKey);
		for (const key of ["source", "mergeBy", "pickupType"]) if (Object.hasOwn(value, key)) assert.ok(typeof value[key] === "string" && value[key].length > 0, `${id}.${key}: expected a nonempty string`);
		if (Object.hasOwn(value, "sourceKey")) assert.equal(value.sourceKey, "unit_id", `${id}: unsupported sourceKey`);
		for (const key of ["mergeHorizontalDistance", "mergeVerticalDistance"]) if (Object.hasOwn(value, key)) assert.ok(Number.isFinite(value[key]) && value[key] >= 0, `${id}.${key}: invalid distance`);
		for (const key of ["distributions", "pickupGroups"]) if (Object.hasOwn(value, key)) assert.ok(Array.isArray(value[key]) && value[key].every((entry) => typeof entry === "string"), `${id}.${key}: expected strings`);
		assert.ok(!(value.distributions && value.pickupType), `${id}: distributions and pickupType cannot both select a family`);
		if (value.auxiliary) {
			fields(value.auxiliary, ["source", "nameKey", "category", "direction"], id + ".auxiliary");
			assert.ok(["trigger", "pickups"].includes(value.auxiliary.source), `${id}: unknown auxiliary source`);
			if (value.auxiliary.source === "trigger") textKey(value.auxiliary.nameKey);
			if (value.auxiliary.category) category(value.auxiliary.category);
			if (value.auxiliary.direction) assert.ok(["to_parent", "from_parent"].includes(value.auxiliary.direction), `${id}: invalid auxiliary direction`);
		}
	}
	for (const [mission, omitted] of Object.entries(markerConfig.omittedFamilies)) {
		for (const id of omitted) assert.ok(Object.hasOwn(markerConfig.families, id), `${mission}: unknown omitted family ${id}`);
	}
	for (const shape of Object.values(markerConfig.explosiveShapes)) textKey(shape.nameKey);
	for (const [family, value] of Object.entries(markerConfig.sourcePolicies)) {
		assert.ok(Object.hasOwn(markerConfig.families, family), `Unknown source policy family: ${family}`);
		fields(value, ["excludedGameModes", "includedGameModes", "breedTags", "projection", "fullNameKey"], family + ".sourcePolicy");
		if (Object.hasOwn(value, "fullNameKey")) textKey(value.fullNameKey);
		for (const key of ["excludedGameModes", "includedGameModes", "breedTags"]) {
			if (!Object.hasOwn(value, key)) continue;
			assert.ok(Array.isArray(value[key]) && value[key].every((entry) => typeof entry === "string"), `${family}.${key}: expected strings`);
		}
		if (!Object.hasOwn(value, "projection")) continue;
		fields(value.projection, ["verticalClearance", "nearestSurfaceDistance"], family + ".projection");
		assert.ok(Number.isFinite(value.projection.verticalClearance) && value.projection.verticalClearance > 0, `${family}: invalid projection clearance`);
		assert.ok(Number.isFinite(value.projection.nearestSurfaceDistance) && value.projection.nearestSurfaceDistance >= 0, `${family}: invalid projection search distance`);
	}
	fields(overrides, ["maps"], "marker overrides");
	object(overrides.maps, "marker overrides.maps");
	for (const [mission, policy] of Object.entries(overrides.maps)) {
		if (missionIds) assert.ok(missionIds.includes(mission), `Marker overrides target unknown map: ${mission}`);
		mapPolicy(mission, policy);
	}
}

export function applyMarkerOverrides(mission, markers, policy = overrides.maps[mission]) {
	if (policy) mapPolicy(mission, policy);
	const pins = structuredClone(markers.pins);
	pins.push(...structuredClone(policy?.add ?? []));
	const primary = new Map(pins.map((pin) => [pin.id, pin]));
	markerIndex(pins);
	const changes = Object.entries(policy?.override ?? {});
	for (const [id, value] of changes.filter(([id]) => primary.has(id))) {
		patch(value, `${mission}.${id}`);
		Object.assign(primary.get(id), structuredClone(value));
	}
	const all = markerIndex(pins);
	for (const [id, value] of changes.filter(([id]) => !primary.has(id))) {
		assert.ok(all.has(id), `${mission}: override targets unknown marker ${id}`);
		patch(value, `${mission}.${id}`, true);
		Object.assign(all.get(id), structuredClone(value));
	}
	const excluded = new Set(policy?.exclude ?? []);
	for (const id of excluded) {
		assert.ok(all.has(id), `${mission}: exclusion targets unknown marker ${id}`);
		assert.ok(!Object.hasOwn(policy?.override ?? {}, id), `${mission}: marker is both overridden and excluded: ${id}`);
	}
	const selected = pins.filter((pin) => !excluded.has(pin.id)).map((pin) => {
		if (pin.auxiliaryMarkers) pin.auxiliaryMarkers = pin.auxiliaryMarkers.filter((entry) => !excluded.has(entry.id));
		marker(pin);
		return pin;
	}).sort((left, right) => left.id.localeCompare(right.id));
	markerIndex(selected);
	const selectedIds = new Set(selected.map((pin) => pin.id));
	const relations = markers.relations.filter((relation) => !excluded.has(relation.from) && !excluded.has(relation.to));
	relations.push(...structuredClone(policy?.relations ?? []));
	const relationKeys = new Set();
	for (const relation of relations) {
		fields(relation, ["kind", "from", "to"], `${mission}: relation`);
		assert.equal(relation.kind, "carry", `${mission}: unsupported relation kind`);
		assert.ok(selectedIds.has(relation.from) && selectedIds.has(relation.to) && relation.from !== relation.to, `${mission}: invalid relation endpoints`);
		const key = `${relation.from}|${relation.to}`;
		assert.ok(!relationKeys.has(key), `${mission}: duplicate relation ${key}`);
		relationKeys.add(key);
	}
	return selected.length ? {pins: selected, relations} : null;
}
