import {mkdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {
	createGeometryPartsGlb,
	createNavmeshGlb,
	createPathLinesGlb,
} from "./gltf.mjs";
import {createMainPathMeshes, createMainPathSummary} from "./main_path.mjs";
import {buildMarkers} from "./markers.mjs";
import {shouldOmitMainPath} from "./config.mjs";
import {validateTerrain} from "./terrain.mjs";
import {createBoundaryPaths} from "./boundaries/index.mjs";
import {assignMarkerFloors, createFloorSlices} from "./floors.mjs";
import {createViewMetadata} from "./view.mjs";
import {
	compactObject,
	directoryFileBytes,
	readDirectoryIfExists,
	sanitizeFileName,
} from "./utils.mjs";

function buildMapMetadata(id, mission, zones) {
	const {zone, titleKey, title} = mission;
	if (!title || !titleKey) throw new Error("Missing extracted mission title");
	if (zone !== undefined && !Object.hasOwn(zones, zone)) throw new Error(`${id}: unknown mission zone ${zone}`);
	return {
		zone,
		titleKey,
		title,
	};
}

async function buildMainPathAsset(missionId, data, context) {
	if (shouldOmitMainPath(missionId)) {
		return null;
	}

	if (data === null) return null;

	if (data.mission !== missionId) {
		throw new Error(`Main path mission mismatch: ${missionId}, got ${data.mission}.`);
	}
	if (data.schema_version !== 2 || data.source !== "all_static_branches") {
		throw new Error(`Main path requires the complete static route graph: ${missionId}`);
	}

	const meshes = createMainPathMeshes(data, context.floors.sampler);

	if (Object.values(meshes).every((mesh) => mesh.indices.length === 0)) {
		throw new Error(`${missionId}: main path contains no renderable segments`);
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
	};
}

async function buildTerrainClipAsset(missionId, context, surface) {
	const fileName = "terrain_clip.glb";
	const outputPath = path.join(context.missionDirectory, fileName);
	const labelOptions = {verticalOffset: surface.data.overlay_offset};
	const glb = createGeometryPartsGlb(`${missionId}_terrain_clip`, {
		removed: context.floors.sampler.labelMesh(surface.removedMesh, labelOptions),
	}, {
		schemaVersion: surface.data.schema_version,
		kind: "terrainClip",
		detection: surface.data.detection,
	});

	await writeFile(outputPath, glb);

	return {
		asset: {
			file: `./data/maps/${sanitizeFileName(missionId)}/${fileName}`,
		},
	};
}

async function buildNavmeshBoundaryAsset(missionId, navmesh, context) {
	const sliced = createBoundaryPaths(navmesh, context.referenceNavmesh, context.removed)
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

export async function buildMissionAssets(packet, context) {
	const data = packet.navmesh;
	if (data.mission !== packet.id) throw new Error(`Nav mission mismatch: ${packet.id}`);

	const missionDirectory = path.join(context.outputDirectory, "maps", sanitizeFileName(data.mission));
	await rm(missionDirectory, {recursive: true, force: true});
	await mkdir(missionDirectory, {recursive: true});

	const fileName = "navmesh.glb";
	const outputPath = path.join(missionDirectory, fileName);
	if (data.source?.kind !== "offline_navdata") {
		throw new Error(`${data.mission}: map build requires offline NavData.`);
	}
	const surface = validateTerrain(packet);
	const renderNavmesh = surface.navmesh;
	const floors = createFloorSlices(data);
	const mesh = floors.sampler.labelMesh({
		positions: renderNavmesh.vertices.flat(),
		indices: renderNavmesh.triangles.flatMap(triangle => triangle.slice(0, 3).map(index => index - 1)),
		normals: new Array(renderNavmesh.vertices.length * 3).fill(0),
	});
	floors.navmesh = {...renderNavmesh,
		vertices: Array.from({length: mesh.floorIds.length}, (_, index) => mesh.positions.slice(index * 3, index * 3 + 3)),
		triangles: Array.from({length: mesh.indices.length / 3}, (_, index) => mesh.indices.slice(index * 3, index * 3 + 3).map(vertex => vertex + 1)),
		floorIds: mesh.floorIds};
	Object.assign(floors.manifest.stats, {
		outputVertices: mesh.floorIds.length,
		outputTriangles: mesh.indices.length / 3,
	});
	const mainPath = await buildMainPathAsset(data.mission, packet.mainPath, {
		...context,
		missionDirectory,
		floors,
	});
	const markers = buildMarkers(data.mission, packet.markers);
	const terrainClip = await buildTerrainClipAsset(data.mission, {
		...context,
		missionDirectory,
		floors,
	}, surface);
	const layeredMarkers = assignMarkerFloors(markers, floors);
	const glb = createNavmeshGlb(floors.navmesh);
	const boundaries = await buildNavmeshBoundaryAsset(data.mission, renderNavmesh, {
		...context,
		missionDirectory,
		referenceNavmesh: data,
		removed: {mesh: surface.removedMesh, verticalOffset: surface.data.overlay_offset},
		floors,
	});

	await writeFile(outputPath, glb);

	const manifestEntry = {
		id: data.mission,
		file: `./data/maps/${sanitizeFileName(data.mission)}/map.json`,
		...buildMapMetadata(packet.id, packet.metadata, context.zones),
	};
	const mapData = {
		id: data.mission,
		file: `./data/maps/${sanitizeFileName(data.mission)}/${fileName}`,
		bounds: renderNavmesh.bounds,
		view: createViewMetadata(renderNavmesh),
		floorSlices: {algorithm: floors.manifest.algorithm, layers: floors.manifest.layers},
		boundaries,
		landmarks: mainPath ? {mainPath: mainPath.asset} : {},
		markers: layeredMarkers ?? undefined,
		diagnostics: {terrainClip: terrainClip.asset},
	};
	const mapJson = `${JSON.stringify(context.gameText.pack(compactObject(mapData)))}\n`;

	await writeFile(path.join(missionDirectory, "map.json"), mapJson);

	manifestEntry.resourceBytes = await directoryFileBytes(missionDirectory);

	return {
		manifest: manifestEntry,
		data: mapData,
		assetBytes: glb.length,
		report: {id: packet.id, floors: floors.manifest, terrain: surface.stats},
	};
}

export async function removeStaleAssets(outputDirectory, maps) {
	const mapOutputDirectory = path.join(outputDirectory, "maps");
	const outputMapDirectories = await readDirectoryIfExists(mapOutputDirectory);
	const expectedMapDirectories = new Set(maps.map((map) => sanitizeFileName(map.data.id)));

	for (const outputMapDirectory of outputMapDirectories) {
		if (!expectedMapDirectories.has(outputMapDirectory)) {
			await rm(path.join(mapOutputDirectory, outputMapDirectory), {recursive: true});
		}
	}
}
