import path from "node:path";
import {PREPROCESS_CONFIG, shouldOmitMarkerCategory} from "./config.mjs";
import {arrayFromLuaJson, readOptionalFile, sanitizeFileName, stableHash} from "./utils.mjs";

const MARKERS = PREPROCESS_CONFIG.markers;
const MAIN_PATH = PREPROCESS_CONFIG.mainPath;
const SUPPLY_DISTRIBUTIONS = new Set(MARKERS.supplyDistributions);

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

function buildMarkerRelations(group, family, options) {
	if (!family.relations) {
		return undefined;
	}

	if (group.length !== 1) {
		throw new Error(`${family.fileLabel} relation markers must not be merged.`);
	}

	return family.relations(group[0], options);
}

function bossTriggerRelations(pin, options) {
	const travelDistance = pin.trigger?.travel_distance;

	if (travelDistance === undefined) {
		return undefined;
	}

	if (!options.mainPathSampler) {
		throw new Error("Boss trigger marker requires main path data.");
	}

	const position = options.mainPathSampler.positionAt(travelDistance);

	return [
		{
			type: "boss_trigger",
			position: [position[0], position[1], position[2] + MAIN_PATH.verticalOffset],
		},
	];
}

function buildMarkerGroup(missionId, group, markerMetadata, family, options) {
	const sourceKeys = group.map((pin) => family.sourceKey(pin)).sort();
	const id = family.id(missionId, sourceKeys);
	const override = markerMetadata.overrides?.[id] ?? {};
	const relations = buildMarkerRelations(group, family, options);

	return {
		id,
		category: family.category,
		name: override.name ?? markerName(group, family),
		position: override.position ?? centerPosition(group),
		relations,
	};
}

function buildMarkerPins(missionId, pins, markerMetadata, family, options) {
	const selectedPins = family.selectPins ? pins.filter(family.selectPins) : pins;
	const groups = family.mergeHorizontalDistance > 0 && family.mergeVerticalDistance >= 0
		? clusterPins(selectedPins, family.mergeHorizontalDistance, family.mergeVerticalDistance)
		: selectedPins.map((pin) => [pin]);

	return groups
		.map((group) => buildMarkerGroup(missionId, group, markerMetadata, family, options))
		.sort((left, right) => left.id.localeCompare(right.id));
}

function markerId(prefix) {
	return (missionId, sourceKeys) => `${prefix}_${stableHash(`${missionId}|${sourceKeys.join("|")}`)}`;
}

function markerFamilies(directories) {
	return [
		{
			category: "chest",
			defaultName: {key: "markerChest"},
			directory: path.join(directories.root, "chests"),
			fileLabel: "Chest marker",
			id(missionId, sourceKeys) {
				return `chest_${stableHash(`${missionId}|${sourceKeys.join("|")}`)}`;
			},
			mergeHorizontalDistance: MARKERS.chestMergeHorizontalDistance,
			mergeVerticalDistance: MARKERS.chestMergeVerticalDistance,
			sourceKey: chestSourceKey,
			stackName: {key: "markerChestStack"},
		},
		{
			category: "health_station",
			defaultName: {key: "markerHealthStation"},
			directory: path.join(directories.root, "health_stations"),
			fileLabel: "Health station marker",
			id: markerId("health_station"),
			sourceKey,
		},
		{
			category: "respawn_point",
			defaultName: {key: "markerRespawnPoint"},
			directory: path.join(directories.root, "respawn_points"),
			fileLabel: "Respawn point marker",
			id: markerId("respawn_point"),
			mergeHorizontalDistance: MARKERS.respawnPointMergeHorizontalDistance,
			mergeVerticalDistance: MARKERS.respawnPointMergeVerticalDistance,
			sourceKey,
		},
		{
			category: "supply_spawn",
			defaultName: {key: "markerSupplySpawn"},
			directory: path.join(directories.root, "pickups"),
			fileLabel: "Supply spawn marker",
			id: markerId("supply_spawn"),
			selectPins(pin) {
				return SUPPLY_DISTRIBUTIONS.has(pin.source?.distribution_type);
			},
			sourceKey,
		},
		{
			category: "side_mission_spawn",
			defaultName: {key: "markerSideMissionSpawn"},
			directory: path.join(directories.root, "pickups"),
			fileLabel: "Side mission spawn marker",
			id: markerId("side_mission_spawn"),
			selectPins(pin) {
				return pin.source?.distribution_type === "side_mission";
			},
			sourceKey,
		},
		{
			category: "boss_spawn",
			defaultName: {key: "markerBossSpawn"},
			directory: path.join(directories.root, "boss_spawns"),
			fileLabel: "Boss spawn marker",
			id: markerId("boss_spawn"),
			relations: bossTriggerRelations,
			sourceKey,
		},
		{
			category: "daemonhost",
			defaultName: {key: "markerDaemonhostSpawn"},
			directory: path.join(directories.root, "daemonhosts"),
			fileLabel: "Daemonhost marker",
			id: markerId("daemonhost"),
			sourceKey,
		},
		{
			category: "havoc_boss_spawn",
			defaultName: {key: "markerHavocBossSpawn"},
			directory: path.join(directories.root, "havoc_boss_spawns"),
			fileLabel: "Havoc boss spawn marker",
			id: markerId("havoc_boss_spawn"),
			relations: bossTriggerRelations,
			sourceKey,
		},
	];
}

export async function buildMarkers(missionId, markerMetadata, directories, options = {}) {
	const markerOutputs = [];
	const sources = new Map();

	for (const family of markerFamilies(directories)) {
		if (shouldOmitMarkerCategory(missionId, family.category)) {
			continue;
		}

		const inputPath = path.join(family.directory, `${sanitizeFileName(missionId)}.json`);
		let source = sources.get(inputPath);

		if (source === undefined) {
			source = await readOptionalFile(inputPath);
			sources.set(inputPath, source);
		}

		if (!source) {
			continue;
		}

		const data = JSON.parse(source);

		if (data.mission !== missionId) {
			throw new Error(`${family.fileLabel} mission mismatch: ${inputPath}. Expected ${missionId}, got ${data.mission}.`);
		}

		markerOutputs.push(...buildMarkerPins(
			missionId,
			arrayFromLuaJson(data.pins, `${family.fileLabel} pins in ${inputPath}`),
			markerMetadata,
			family,
			options,
		));
	}

	if (markerOutputs.length === 0) {
		return null;
	}

	return {
		pins: markerOutputs.sort((left, right) => left.id.localeCompare(right.id)),
	};
}
