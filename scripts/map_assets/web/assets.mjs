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
import {validateReach, validateTerrain} from "./terrain.mjs";
import {createBoundaryPaths} from "./boundaries/index.mjs";
import {assignMarkerFloors, createFloorSlices} from "./floors.mjs";
import {combineFloorSamplers} from "./floors/sampler.mjs";
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

	const meshes = createMainPathMeshes(data, context.sampler);

	if (Object.values(meshes).every((mesh) => mesh.indices.length === 0)) {
		throw new Error(`${missionId}: main path contains no renderable segments`);
	}

	const fileName = "main_path.glb";
	const outputPath = path.join(context.missionDirectory, fileName);
	const glb = await createGeometryPartsGlb(`${missionId}_main_path`, meshes, {
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
	const glb = await createGeometryPartsGlb(`${missionId}_terrain_clip`, {
		removed: context.sampler.labelMesh(surface.removedMesh, labelOptions),
	}, {
		schemaVersion: surface.data.schema_version,
		kind: "terrainClip",
		detection: surface.data.detection,
	});

	await writeFile(outputPath, glb);

	return {
		byteLength: glb.length,
		asset: {
			file: `./data/maps/${sanitizeFileName(missionId)}/${fileName}`,
		},
	};
}

async function buildNavmeshBoundaryAsset(missionId, navmesh, shown, context) {
	const outline = (mesh, sampler) => createBoundaryPaths(mesh).flatMap((boundary) => sampler.splitPath(boundary));
	const all = outline(navmesh, context.floors.sampler);
	const reachable = outline({...navmesh, triangles: shown}, context.reachFloors.sampler);
	const sliced = [...all, ...reachable];
	const paths = sliced.map((boundary) => boundary.path);
	const stats = {
		paths: paths.length,
		points: paths.reduce((sum, path) => sum + path.length, 0),
		groups: {all: all.length, reach: reachable.length},
	};
	const fileName = "navmesh_boundaries.glb";
	const outputPath = path.join(context.missionDirectory, fileName);
	const glb = await createPathLinesGlb(`${missionId}_navmesh_boundaries`, paths, {
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

function meshArrays(navmesh) {
	return {
		positions: navmesh.vertices.flat(),
		indices: navmesh.triangles.flatMap((triangle) => triangle.slice(0, 3).map((index) => index - 1)),
		normals: new Array(navmesh.vertices.length * 3).fill(0),
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
	const reach = validateReach(packet);
	const renderNavmesh = surface.navmesh;
	// Keep reachable triangles first for prefix rendering. All-nav layers use the original reference nav;
	// reachable layers use shown carved triangles, excluding unreachable-only layers from the default view.
	const shownSet = new Set(reach.shownTriangles);
	const shown = reach.shownTriangles.map((index) => renderNavmesh.triangles[index]);
	const ordered = [...shown, ...renderNavmesh.triangles.filter((_, index) => !shownSet.has(index))];
	const floors = createFloorSlices(data);
	const reachFloors = reach.evaluated ? createFloorSlices({...renderNavmesh, mission: data.mission, triangles: shown}) : floors;
	const sampler = combineFloorSamplers(floors.sampler, reachFloors.sampler);
	// labelMesh preserves source order, so the reachable prefix remains contiguous after slicing.
	const mesh = sampler.labelMesh(meshArrays({vertices: renderNavmesh.vertices, triangles: ordered}));
	const shownTriangles = mesh.sources.filter((source) => source < shown.length).length;
	const navmesh = {...renderNavmesh,
		vertices: Array.from({length: mesh.floorIds.length}, (_, index) => mesh.positions.slice(index * 3, index * 3 + 3)),
		triangles: Array.from({length: mesh.indices.length / 3}, (_, index) => mesh.indices.slice(index * 3, index * 3 + 3).map(vertex => vertex + 1)),
		floorIds: mesh.floorIds};
	Object.assign(floors.manifest.stats, {
		outputVertices: mesh.floorIds.length,
		outputTriangles: mesh.indices.length / 3,
	});
	const assetContext = {...context, missionDirectory, floors, reachFloors, sampler};
	const mainPath = await buildMainPathAsset(data.mission, packet.mainPath, assetContext);
	const markers = buildMarkers(data.mission, packet.markers);
	const terrainClip = await buildTerrainClipAsset(data.mission, assetContext, surface);
	const layeredMarkers = assignMarkerFloors(markers, sampler);
	const glb = await createNavmeshGlb(navmesh);
	const boundaries = await buildNavmeshBoundaryAsset(data.mission, renderNavmesh, shown, assetContext);

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
		floorSlices: {
			algorithm: floors.manifest.algorithm,
			layers: floors.manifest.layers,
			reachLayers: reachFloors.manifest.layers,
		},
		reach: {evaluated: reach.evaluated, shownTriangles},
		boundaries,
		landmarks: mainPath ? {mainPath: mainPath.asset} : {},
		markers: layeredMarkers ?? undefined,
		diagnostics: {terrainClip: terrainClip.asset},
	};
	const mapJson = `${JSON.stringify(context.gameText.pack(compactObject(mapData)))}\n`;

	await writeFile(path.join(missionDirectory, "map.json"), mapJson);

	manifestEntry.resourceBytes = await directoryFileBytes(missionDirectory) - terrainClip.byteLength;
	manifestEntry.debugResourceBytes = terrainClip.byteLength;

	return {
		manifest: manifestEntry,
		data: mapData,
		assetBytes: glb.length,
		report: {id: packet.id, floors: floors.manifest, reachFloors: reachFloors.manifest, terrain: surface.stats,
			reach: reach.stats},
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
