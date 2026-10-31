import {BUILD_CONFIG} from "./config.mjs";
import markerConfig from "../../../config/markers.json" with {type: "json"};
import {requireArray, compactObject, stableHash} from "./utils.mjs";
import {applyMarkerOverrides} from "./marker_overrides.mjs";

const MAIN_PATH = BUILD_CONFIG.mainPath;
const SIDE_MISSION_PICKUP_TYPES = new Set(Object.values(markerConfig.families)
	.map((family) => family.pickupType).filter(Boolean));

function chestSourceKey(pin) {
	if (pin.source?.unit_id) {
		return pin.source.unit_id;
	}

	throw new Error("Chest marker pin is missing source.unit_id.");
}

function sourceKey(pin) {
	if (pin.source && typeof pin.source === "object") {
		return JSON.stringify(Object.keys(pin.source)
			.sort()
			.map((key) => [key, pin.source[key]]));
	}

	throw new Error("Marker pin is missing source.");
}

function hasPickupType(pin, type) {
	if (pin.source?.distribution_type !== "side_mission" || !Array.isArray(pin.spawnable_pickups)) return false;
	const types = new Set(pin.spawnable_pickups.filter((pickup) => SIDE_MISSION_PICKUP_TYPES.has(pickup)));
	return types.size === 1 && types.has(type);
}

function horizontalDistanceSquared(left, right) {
	return [0, 1].reduce((sum, axis) => {
		const delta = left[axis] - right[axis];

		return sum + delta * delta;
	}, 0);
}

function canMergePins(left, right, horizontalDistance, verticalDistance) {
	const maximumHorizontalDistanceSquared = horizontalDistance * horizontalDistance;

	return horizontalDistanceSquared(left.position, right.position) <= maximumHorizontalDistanceSquared
		&& Math.abs(left.position[2] - right.position[2]) <= verticalDistance;
}

function centerPosition(pins) {
	const center = [0, 0, 0];

	for (const pin of pins) {
		for (let index = 0; index < center.length; index++) {
			center[index] += pin.position[index];
		}
	}

	return center.map((value) => value / pins.length);
}

function clusterPins(pins, horizontalDistance, verticalDistance) {
	const groups = [];
	const remaining = new Set(pins);

	for (const pin of pins) {
		if (!remaining.has(pin)) {
			continue;
		}

		const group = [];
		const queue = [pin];

		remaining.delete(pin);

		while (queue.length > 0) {
			const current = queue.pop();

			group.push(current);

			for (const candidate of [...remaining]) {
				if (canMergePins(current, candidate, horizontalDistance, verticalDistance)) {
					remaining.delete(candidate);
					queue.push(candidate);
				}
			}
		}

		groups.push(group);
	}

	return groups;
}

function markerName(group, family) {
	if (group.length > 1 && family.stackName) {
		return {
			...family.stackName,
			values: {
				...(family.stackName.values ?? {}),
				count: group.length,
			},
		};
	}

	if (group[0].name_key) {
		return {key: group[0].name_key};
	}

	return group[0].name ?? family.defaultName;
}

function keyedValue(key) {
	return key ? {key} : undefined;
}

function validatePosition(position, label) {
	if (!Array.isArray(position) || position.length !== 3 || position.some((value) => typeof value !== "number")) {
		throw new Error(`${label} position must be a numeric [x, y, z] array.`);
	}
}

function buildMarkerAuxiliaryMarkers(group, family) {
	if (!family.auxiliaryMarkers) {
		return undefined;
	}

	if (group.length !== 1) {
		throw new Error(`${family.fileLabel} auxiliary markers must not be merged.`);
	}

	return family.auxiliaryMarkers(group[0]);
}

function bossTriggerAuxiliaryMarkers(pin, style) {
	if (!pin.trigger) return undefined;
	return requireArray(pin.trigger.positions, "boss trigger positions").map(({position}) => ({
		key: `boss_trigger_${stableHash(JSON.stringify(position))}`,
		name: {key: style.nameKey},
		category: style.category,
		direction: style.direction,
		position: [position[0], position[1], position[2] + MAIN_PATH.verticalOffset],
	}));
}

function pickupAuxiliaryMarkers(pin, style) {
	return (pin.auxiliary_markers ?? []).map((auxiliary) => ({
		...auxiliary, ...style,
		position: [auxiliary.position[0], auxiliary.position[1], auxiliary.position[2] + MAIN_PATH.verticalOffset],
	}));
}

function auxiliaryId(missionId, category, sourceKeys, auxiliaryKey) {
	return `${category}_aux_${stableHash(`${missionId}|${category}|${sourceKeys.join("|")}|${auxiliaryKey}`)}`;
}

function buildAuxiliaryMarkers(missionId, category, sourceKeys, auxiliaryMarkers = []) {
	if (auxiliaryMarkers.length === 0) {
		return undefined;
	}

	const keys = new Set();

	return auxiliaryMarkers.map((auxiliary) => {
		if (!auxiliary.key) {
			throw new Error(`Auxiliary marker for ${category} marker is missing key.`);
		}

		if (keys.has(auxiliary.key)) {
			throw new Error(`Duplicate auxiliary marker key for ${category} marker: ${auxiliary.key}.`);
		}

		keys.add(auxiliary.key);
		validatePosition(auxiliary.position, `Auxiliary marker ${auxiliary.key}`);

		return compactObject({
			id: auxiliaryId(missionId, category, sourceKeys, auxiliary.key),
			name: auxiliary.name ?? keyedValue(auxiliary.nameKey),
			position: auxiliary.position,
			category: auxiliary.category,
			direction: auxiliary.direction,
		});
	});
}

function buildMarkerGroup(missionId, group, family) {
	const sourceKeys = group.map((pin) => family.sourceKey(pin)).sort();
	const id = family.id(missionId, sourceKeys);
	const auxiliaryMarkers = buildMarkerAuxiliaryMarkers(group, family);
	const description = Object.hasOwn(group[0], "description") ? group[0].description : keyedValue(group[0].description_key ?? family.descriptionKey);

	return compactObject({
		id,
		category: family.category,
		name: markerName(group, family),
		description,
		position: centerPosition(group),
		auxiliaryMarkers: buildAuxiliaryMarkers(missionId, family.category, sourceKeys, auxiliaryMarkers),
		taskKey: group[0].source.objective ? `${group[0].source.objective}|${group[0].source.unit_id}` : undefined,
	});
}

function buildMarkerPins(missionId, pins, family) {
	const selectedPins = family.selectPins ? pins.filter(family.selectPins) : pins;
	const sets = new Map();
	for (const pin of selectedPins) {
		const key = family.mergeKey ? family.mergeKey(pin) : "all";
		if (!sets.has(key)) sets.set(key, []);
		sets.get(key).push(pin);
	}
	const groups = [...sets.values()].flatMap((set) => family.mergeHorizontalDistance > 0 && family.mergeVerticalDistance >= 0
		? clusterPins(set, family.mergeHorizontalDistance, family.mergeVerticalDistance)
		: set.map((pin) => [pin]));

	return groups
		.map((group) => buildMarkerGroup(missionId, group, family))
		.sort((left, right) => left.id.localeCompare(right.id));
}

function markerId(prefix) {
	return (missionId, sourceKeys) => `${prefix}_${stableHash(`${missionId}|${sourceKeys.join("|")}`)}`;
}

function markerFamilies(missionId) {
	const omitted = markerConfig.omittedFamilies[missionId] ?? [];
	return Object.entries(markerConfig.families)
		.filter(([key]) => !omitted.includes(key))
		.map(([key, config]) => ({
			...config,
			family: config.source ?? key,
			fileLabel: key,
			id: markerId(config.category),
			sourceKey: config.sourceKey === "unit_id" ? chestSourceKey : sourceKey,
			defaultName: keyedValue(config.nameKey),
			stackName: keyedValue(config.stackNameKey),
			mergeKey: config.mergeBy ? (pin) => pin.source[config.mergeBy] : undefined,
			selectPins: config.distributions ? (pin) => config.distributions.includes(pin.source.distribution_type)
				&& (pin.spawnable_pickups === "all" || requireArray(pin.pickup_groups, "pickup groups").some((group) => config.pickupGroups.includes(group)))
				: config.pickupType ? (pin) => hasPickupType(pin, config.pickupType) : undefined,
			auxiliaryMarkers: config.auxiliary?.source === "trigger" ? (pin) => bossTriggerAuxiliaryMarkers(pin, config.auxiliary)
				: config.auxiliary ? (pin) => pickupAuxiliaryMarkers(pin, config.auxiliary) : undefined,
		}));
}

export function buildMarkers(missionId, sources) {
	const pins = [];
	for (const family of markerFamilies(missionId)) {
		pins.push(...buildMarkerPins(missionId, requireArray(sources[family.family], family.fileLabel), family));
	}
	const taskIds = new Map();
	for (const pin of pins) {
		if (!pin.taskKey) continue;
		if (taskIds.has(pin.taskKey)) throw new Error(`Duplicate task marker: ${pin.taskKey}`);
		taskIds.set(pin.taskKey, pin.id);
	}
	const relations = requireArray(sources.relations, "task relations").map((relation) => {
		if (relation.kind !== "carry") throw new Error(`Unknown task relation: ${relation.kind}`);
		const from = taskIds.get(relation.from), to = taskIds.get(relation.to);
		if (!from || !to) throw new Error(`Unresolved task relation: ${JSON.stringify(relation)}`);
		return {kind: relation.kind, from, to};
	});
	return applyMarkerOverrides(missionId, {
		pins: pins.map(({taskKey, ...pin}) => pin).sort((a, b) => a.id.localeCompare(b.id)),
		relations,
	});
}
