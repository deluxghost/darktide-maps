import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {
	createGeometryPartsGlb,
	createNavmeshGlb,
	createPathLinesGlb,
} from "./gltf.mjs";
import {createMainPathMeshes, createMainPathSampler, createMainPathSummary} from "./main_path.mjs";
import {buildMarkers} from "./markers.mjs";
import {shouldOmitMainPath} from "./config.mjs";
import {buildBlockedEdgesOverlay} from "./blocked_edges.mjs";
import {carveNavmesh} from "./blocked_edges/navmesh_carve.mjs";
import {createBoundaryPaths} from "./boundaries.mjs";
import {assignMarkerFloors, createFloorSlices} from "./floors.mjs";
import {createViewMetadata} from "./view.mjs";
import {
	compactObject,
	directoryFileBytes,
	readDirectoryIfExists,
	readOptionalFile,
	sanitizeFileName,
} from "./utils.mjs";

function buildMapMetadata(mission, mapMetadata) {
	if (!mission) {
		return {};
	}

	const zone = mission.zone;
	const nameKey = mission.name_key;

	if (!Object.hasOwn(mapMetadata.missions, nameKey)) {
		throw new Error(`Mission ${mission.id} uses missing mission name key: ${nameKey}. Add it to metadata/map.json first.`);
	}

	return compactObject({
		zone: Object.hasOwn(mapMetadata.zones, zone) ? zone : undefined,
		titleKey: nameKey,
		title: mapMetadata.missions[nameKey],
	});
}

async function buildMainPathAsset(missionId, context) {
	if (shouldOmitMainPath(missionId)) {
		return null;
	}

	const inputPath = path.join(context.directories.mainPath, `${sanitizeFileName(missionId)}.json`);
	const source = await readOptionalFile(inputPath);

	if (!source) {
		return null;
	}

	if (source.length === 0) {
		console.warn(`${missionId}: main path file is empty, skipping.`);

		return null;
	}

	const data = JSON.parse(source);

	if (data.mission !== missionId) {
		throw new Error(`Main path mission mismatch: ${inputPath}. Expected ${missionId}, got ${data.mission}.`);
	}

	const meshes = createMainPathMeshes(data, context.floors.sampler);

	if (Object.values(meshes).every((mesh) => mesh.indices.length === 0)) {
		console.warn(`${missionId}: main path contains no renderable segments, skipping.`);

		return null;
	}

	const fileName = "main_path.glb";
	const outputPath = path.join(context.missionDirectory, fileName);
	const glb = createGeometryPartsGlb(`${missionId}_main_path`, meshes, {
		schemaVersion: data.schema_version,
		kind: "mainPath",
		stats: data.stats,
	});

	await writeFile(outputPath, glb);

	return {
		asset: {
			file: `./data/maps/${sanitizeFileName(missionId)}/${fileName}`,
			...createMainPathSummary(data),
		},
		data,
	};
}

async function buildBlockedEdgesAsset(missionId, context, overlay) {
	if (!overlay?.mesh) {
		return overlay
			? {
				asset: {
					stats: overlay.stats,
				},
			}
			: null;
	}

	const fileName = "blocked_edges.glb";
	const outputPath = path.join(context.missionDirectory, fileName);
	const glb = createGeometryPartsGlb(`${missionId}_blocked_edges`, {
		edges: context.floors.sampler.labelMesh(overlay.mesh),
	}, {
		schemaVersion: overlay.data.schema_version,
		kind: "blockedEdges",
		detection: overlay.data.detection,
		stats: overlay.stats,
	});

	await writeFile(outputPath, glb);

	return {
		asset: {
			file: `./data/maps/${sanitizeFileName(missionId)}/${fileName}`,
			stats: overlay.stats,
		},
	};
}

async function buildNavmeshBoundaryAsset(missionId, navmesh, context) {
	const sliced = createBoundaryPaths(navmesh, context.referenceNavmesh)
		.flatMap((boundary) => context.floors.sampler.splitPath(boundary));
	const paths = sliced.map((boundary) => boundary.path);
	const stats = {
		paths: paths.length,
		points: paths.reduce((sum, path) => sum + path.length, 0),
	};
	const fileName = "navmesh_boundaries.glb";
	const outputPath = path.join(context.missionDirectory, fileName);
	const glb = createPathLinesGlb(`${missionId}_navmesh_boundaries`, paths, {
		schemaVersion: navmesh.schema_version,
		kind: "navmeshBoundaries",
		stats,
		floorIndices: sliced.map((boundary) => boundary.floorIndex),
	});

	await writeFile(outputPath, glb);

	return {
		file: `./data/maps/${sanitizeFileName(missionId)}/${fileName}`,
		stats,
	};
}

export async function buildMissionAssets(inputFileName, context) {
	const inputPath = path.join(context.directories.navmesh, inputFileName);
	const source = await readFile(inputPath);
	const data = JSON.parse(source);
	const expectedInputFileName = `${sanitizeFileName(data.mission)}.json`;

	if (!data.mission) {
		throw new Error(`Navmesh file is missing mission id: ${inputFileName}.`);
	}

	if (inputFileName !== expectedInputFileName) {
		throw new Error(`Unexpected navmesh file name: ${inputFileName}. Expected ${expectedInputFileName}.`);
	}

	if (context.missionIds.has(data.mission)) {
		throw new Error(`Duplicate navmesh mission id: ${data.mission}.`);
	}

	context.missionIds.add(data.mission);

	const missionDirectory = path.join(context.outputDirectory, "maps", sanitizeFileName(data.mission));
	await rm(missionDirectory, {recursive: true, force: true});
	await mkdir(missionDirectory, {recursive: true});

	const fileName = "navmesh.glb";
	const outputPath = path.join(missionDirectory, fileName);
	const overlay = await buildBlockedEdgesOverlay(data.mission, context.directories, data);
	const carved = carveNavmesh(data, overlay?.footprints ?? []);
	const renderNavmesh = carved.navmesh;
	const floors = createFloorSlices(renderNavmesh);
	const mainPath = await buildMainPathAsset(data.mission, {
		...context,
		missionDirectory,
		floors,
	});
	const mainPathSampler = mainPath ? createMainPathSampler(mainPath.data) : null;
	const markers = await buildMarkers(data.mission, context.markerMetadata, {
		root: context.directories.markers,
	}, {
		mainPathSampler,
	});
	const blockedEdges = await buildBlockedEdgesAsset(data.mission, {
		...context,
		missionDirectory,
		floors,
	}, overlay);
	const layeredMarkers = assignMarkerFloors(markers, floors);
	const glb = createNavmeshGlb(floors.navmesh);
	const boundaries = await buildNavmeshBoundaryAsset(data.mission, renderNavmesh, {
		...context,
		missionDirectory,
		referenceNavmesh: data,
		floors,
	});

	await writeFile(outputPath, glb);

	const manifestEntry = {
		id: data.mission,
		file: `./data/maps/${sanitizeFileName(data.mission)}/map.json`,
		...buildMapMetadata(context.missionIndex.get(data.mission), context.mapMetadata),
	};
	const mapData = {
		id: data.mission,
		file: `./data/maps/${sanitizeFileName(data.mission)}/${fileName}`,
		bounds: renderNavmesh.bounds,
		view: createViewMetadata(renderNavmesh),
		floorSlices: floors.manifest,
		boundaries,
		landmarks: mainPath ? {mainPath: mainPath.asset} : {},
		markers: layeredMarkers ?? undefined,
		diagnostics: blockedEdges ? {blockedEdges: {
			...blockedEdges.asset,
			navmeshCarve: carved.stats,
		}} : undefined,
	};
	const mapJson = `${JSON.stringify(compactObject(mapData), null, "\t")}\n`;

	await writeFile(path.join(missionDirectory, "map.json"), mapJson);

	manifestEntry.resourceBytes = await directoryFileBytes(missionDirectory);

	return {
		manifest: manifestEntry,
		data: mapData,
		sourceBytes: source.length,
		assetBytes: glb.length,
	};
}

export async function removeStaleAssets(outputDirectory, maps) {
	const mapOutputDirectory = path.join(outputDirectory, "maps");
	const outputMapDirectories = await readDirectoryIfExists(mapOutputDirectory);
	const expectedMapDirectories = new Set(maps.map((map) => sanitizeFileName(map.data.id)));
	const outputFiles = await readDirectoryIfExists(outputDirectory);

	for (const outputFileName of outputFiles) {
		if (outputFileName.endsWith(".glb")) {
			await rm(path.join(outputDirectory, outputFileName));
		}
	}

	for (const outputMapDirectory of outputMapDirectories) {
		if (!expectedMapDirectories.has(outputMapDirectory)) {
			await rm(path.join(mapOutputDirectory, outputMapDirectory), {recursive: true});
		}
	}
}
