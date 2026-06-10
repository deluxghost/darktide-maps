import path from "node:path";
import {PREPROCESS_CONFIG} from "./config.mjs";
import {filterDoorEdges, filterEdges} from "./blocked_edges/analysis.mjs";
import {filterExcludedPolygons} from "./blocked_edges/exclusions.mjs";
import {createSamplePolygons} from "./blocked_edges/polygons.mjs";
import {createBlockedFootprints} from "./blocked_edges/navmesh_carve.mjs";
import {filterMarkerCollisionEdges, filterVolumeEdges} from "./blocked_edges/volumes.mjs";
import {arrayFromLuaJson, readOptionalJson, sanitizeFileName} from "./utils.mjs";

const MARKER_COLLISION_FILTER = PREPROCESS_CONFIG.blockedEdges.markerCollisionFilter;
const MANUAL_EXCLUDE_FILTER = PREPROCESS_CONFIG.blockedEdges.manualExcludes;
const DYNAMIC_VOLUME_FILTER_SOURCES = new Set([
	"MoveablePlatform",
	"RitualShield",
]);
const DYNAMIC_VOLUME_INCLUDE_SOURCES = new Set([
	"NavBlock",
]);

if (!Number.isFinite(MANUAL_EXCLUDE_FILTER?.verticalTolerance)) {
	throw new Error("Missing blocked edge manual exclude config: verticalTolerance");
}

if (!MANUAL_EXCLUDE_FILTER?.byMission || typeof MANUAL_EXCLUDE_FILTER.byMission !== "object") {
	throw new Error("Missing blocked edge manual exclude config: byMission");
}

async function readMarkerCollisionMarkers(missionId, directories) {
	if (!directories.markers) {
		return [];
	}

	const markers = [];

	for (const family of MARKER_COLLISION_FILTER.families) {
		const inputPath = path.join(directories.markers, family, `${sanitizeFileName(missionId)}.json`);
		const data = await readOptionalJson(inputPath);

		if (!data) {
			continue;
		}

		if (data.mission !== missionId) {
			throw new Error(`Marker collision filter mission mismatch: ${inputPath}. Expected ${missionId}, got ${data.mission}.`);
		}

		for (const pin of arrayFromLuaJson(data.pins ?? [], `${inputPath} pins`)) {
			if (!Array.isArray(pin.position) || pin.position.length !== 3) {
				throw new Error(`Marker collision filter pin in ${inputPath} is missing a valid position.`);
			}

			markers.push({
				position: pin.position,
				distance: MARKER_COLLISION_FILTER.distance,
			});
		}
	}

	return markers;
}

async function readMissionJson(directories, family, missionId, propertyName) {
	const directory = directories[family];
	const inputPath = directory && path.join(directory, `${sanitizeFileName(missionId)}.json`);
	const data = inputPath ? await readOptionalJson(inputPath) : null;

	if (data && data.mission !== missionId) {
		throw new Error(`${propertyName} mission mismatch: ${inputPath}. Expected ${missionId}, got ${data.mission}.`);
	}

	return {
		inputPath,
		items: arrayFromLuaJson(data?.[propertyName] ?? [], `${inputPath ?? propertyName} ${propertyName}`),
	};
}

export async function buildBlockedEdgesOverlay(missionId, directories, navmesh) {
	if (!directories.blockedEdges) {
		return null;
	}

	const inputPath = path.join(directories.blockedEdges, `${sanitizeFileName(missionId)}.json`);
	const data = await readOptionalJson(inputPath);

	if (!data) {
		return null;
	}

	if (data.mission !== missionId) {
		throw new Error(`Blocked edge mission mismatch: ${inputPath}. Expected ${missionId}, got ${data.mission}.`);
	}

	const edges = arrayFromLuaJson(data.edges, `${inputPath} edges`);
	const {items: doors} = await readMissionJson(directories, "doors", missionId, "doors");
	const {items: dynamicVolumes} = await readMissionJson(directories, "dynamicVolumes", missionId, "volumes");
	const filteredDynamicVolumes = dynamicVolumes.filter((volume) => DYNAMIC_VOLUME_FILTER_SOURCES.has(volume.source));
	const includedDynamicVolumes = dynamicVolumes.filter((volume) => (
		DYNAMIC_VOLUME_INCLUDE_SOURCES.has(volume.source)
		&& volume.state === "blocked"
	));
	const markerCollisionMarkers = await readMarkerCollisionMarkers(missionId, directories);
	const doorFilteredEdges = filterDoorEdges(edges, doors, includedDynamicVolumes, navmesh);
	const dynamicVolumeFilteredEdges = filterVolumeEdges(doorFilteredEdges, filteredDynamicVolumes);
	const markerCollisionFilteredEdges = filterMarkerCollisionEdges(dynamicVolumeFilteredEdges, markerCollisionMarkers);
	const filtered = filterEdges(markerCollisionFilteredEdges, navmesh, includedDynamicVolumes);
	const samplePolygons = createSamplePolygons(data.samples, filtered.edges);
	const excludePoints = MANUAL_EXCLUDE_FILTER.byMission[missionId] ?? [];
	const excludedPolygons = filterExcludedPolygons(missionId, navmesh, samplePolygons.polygons, excludePoints, {
		verticalTolerance: MANUAL_EXCLUDE_FILTER.verticalTolerance,
	});
	const blockedFootprints = createBlockedFootprints(navmesh, excludedPolygons.polygons);

	return {
		data,
		footprints: blockedFootprints.footprints,
		mesh: blockedFootprints.mesh,
		stats: {
			inputEdges: edges.length,
			doorFilteredEdges: edges.length - doorFilteredEdges.length,
			dynamicVolumeFilteredEdges: doorFilteredEdges.length - dynamicVolumeFilteredEdges.length,
			markerCollisionFilteredEdges: dynamicVolumeFilteredEdges.length - markerCollisionFilteredEdges.length,
			inputComponents: filtered.components.length,
			includedComponents: filtered.includedComponents.length,
			splitComponents: filtered.splitComponents.length,
			renderedComponents: filtered.keptComponents.length,
			renderedFragments: filtered.renderedFragments.length,
			keptRenderedFragments: filtered.keptRenderedFragments.length,
			filteredEdges: edges.length - filtered.edges.length,
			renderedEdges: filtered.edges.length,
			sourcePolygons: samplePolygons.polygonCount,
			manualExcludePoints: excludedPolygons.excludePoints,
			manualExcludedPolygons: excludedPolygons.excludedPolygons,
			renderedTriangles: blockedFootprints.stats.triangles,
			renderedPolygons: blockedFootprints.stats.footprints,
		},
	};
}
