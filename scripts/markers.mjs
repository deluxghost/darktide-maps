import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {arrayFromLuaJson} from "./json.js";

const CHEST_MERGE_HORIZONTAL_DISTANCE = 2;
const CHEST_MERGE_VERTICAL_DISTANCE = 1;

function stableHash(value) {
	return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

async function readOptionalFile(filePath) {
	try {
		return await readFile(filePath);
	} catch (error) {
		if (error.code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

function sanitizeFileName(value) {
	return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

function chestSourceKey(pin) {
	if (pin.source?.unit_id) {
		return pin.source.unit_id;
	}

	throw new Error("Chest marker pin is missing source.unit_id.");
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

	return group[0].name ?? family.defaultName;
}

function buildMarkerGroup(missionId, group, markerMetadata, family) {
	const sourceKeys = group.map((pin) => family.sourceKey(pin)).sort();
	const id = family.id(missionId, sourceKeys);
	const override = markerMetadata.overrides?.[id] ?? {};

	return {
		id,
		category: family.category,
		name: override.name ?? markerName(group, family),
		position: override.position ?? centerPosition(group),
	};
}

function buildMarkerPins(missionId, pins, markerMetadata, family) {
	const groups = family.mergeHorizontalDistance > 0 && family.mergeVerticalDistance >= 0
		? clusterPins(pins, family.mergeHorizontalDistance, family.mergeVerticalDistance)
		: pins.map((pin) => [pin]);

	return groups
		.map((group) => buildMarkerGroup(missionId, group, markerMetadata, family))
		.sort((left, right) => left.id.localeCompare(right.id));
}

function markerFamilies(directories) {
	return [
		{
			category: "chest",
			defaultName: {key: "markerChestName"},
			directory: directories.chests,
			fileLabel: "Chest marker",
			id(missionId, sourceKeys) {
				return `chest_${stableHash(`${missionId}|${sourceKeys.join("|")}`)}`;
			},
			mergeHorizontalDistance: CHEST_MERGE_HORIZONTAL_DISTANCE,
			mergeVerticalDistance: CHEST_MERGE_VERTICAL_DISTANCE,
			sourceKey: chestSourceKey,
			stackName: {key: "markerChestStack"},
		},
	];
}

export async function buildMarkers(missionId, markerMetadata, directories) {
	const markerOutputs = [];
	let sourceBytes = 0;

	for (const family of markerFamilies(directories)) {
		const inputPath = path.join(family.directory, `${sanitizeFileName(missionId)}.json`);
		const source = await readOptionalFile(inputPath);

		if (!source) {
			continue;
		}

		const data = JSON.parse(source);

		if (data.mission !== missionId) {
			throw new Error(`${family.fileLabel} mission mismatch: ${inputPath}. Expected ${missionId}, got ${data.mission}.`);
		}

		sourceBytes += source.length;
		markerOutputs.push(...buildMarkerPins(
			missionId,
			arrayFromLuaJson(data.pins, `${family.fileLabel} pins in ${inputPath}`),
			markerMetadata,
			family,
		));
	}

	if (markerOutputs.length === 0) {
		return null;
	}

	return {
		pins: markerOutputs.sort((left, right) => left.id.localeCompare(right.id)),
		stats: {
			pins: markerOutputs.length,
		},
		sourceBytes,
	};
}
