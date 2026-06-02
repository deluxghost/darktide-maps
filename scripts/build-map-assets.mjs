import {mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {createGeometryPartsGlb, createNavmeshGlb} from "./gltf-writer.mjs";
import {createMainPathMeshes} from "./main-path-geometry.mjs";

const inputDirectory = process.argv[2];
const outputDirectory = process.argv[3] ?? path.resolve("public", "data");
const navmeshDirectory = inputDirectory && path.join(inputDirectory, "navmesh");
const mainPathDirectory = inputDirectory && path.join(inputDirectory, "main_path");
const metadataDirectory = inputDirectory && path.join(inputDirectory, "metadata");
const mapMetadataPath = path.resolve("map-metadata.json");

if (!inputDirectory) {
	throw new Error("Usage: node scripts/build-map-assets.mjs <nav-exporter-directory> [output-directory]");
}

function sanitizeFileName(value) {
	return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

async function readDirectoryIfExists(directory) {
	try {
		return await readdir(directory);
	} catch (error) {
		if (error.code === "ENOENT") {
			return [];
		}

		throw error;
	}
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

async function readOptionalJson(filePath) {
	const source = await readOptionalFile(filePath);

	return source ? JSON.parse(source) : null;
}

function indexById(items, sourceName) {
	const index = new Map();

	for (const item of items ?? []) {
		if (!item.id) {
			throw new Error(`${sourceName} item is missing id.`);
		}

		if (index.has(item.id)) {
			throw new Error(`Duplicate ${sourceName} id: ${item.id}.`);
		}

		index.set(item.id, item);
	}

	return index;
}

function buildMapMetadata(mission, mapMetadata) {
	if (!mission) {
		return {};
	}

	const zone = mission.zone;
	const nameKey = mission.name_key;

	if (!Object.hasOwn(mapMetadata.missions, nameKey)) {
		throw new Error(`Mission ${mission.id} uses missing mission name key: ${nameKey}. Add it to map-metadata.json first.`);
	}

	return compactObject({
		zone: Object.hasOwn(mapMetadata.zones, zone) ? zone : undefined,
		titleKey: nameKey,
		title: mapMetadata.missions[nameKey],
	});
}

function compactObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}

	const entries = Object.entries(value)
		.map(([key, child]) => [key, compactObject(child)])
		.filter(([, child]) => child !== undefined);

	if (entries.length === 0) {
		return undefined;
	}

	return Object.fromEntries(entries);
}

async function buildMainPathAsset(missionId) {
	const inputPath = path.join(mainPathDirectory, `${sanitizeFileName(missionId)}.json`);
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

	const meshes = createMainPathMeshes(data);

	if (Object.values(meshes).every((mesh) => mesh.indices.length === 0)) {
		console.warn(`${missionId}: main path contains no renderable segments, skipping.`);

		return null;
	}

	const fileName = `${sanitizeFileName(missionId)}.main_path.glb`;
	const outputPath = path.join(outputDirectory, fileName);
	const glb = createGeometryPartsGlb(`${missionId}_main_path`, meshes, {
		schemaVersion: data.schema_version,
		kind: "mainPath",
		stats: data.stats,
	});

	await writeFile(outputPath, glb);

	return {
		file: `./data/${fileName}`,
		sourceBytes: source.length,
		assetBytes: glb.length,
		stats: data.stats,
	};
}

await mkdir(outputDirectory, {recursive: true});

const metadata = await readOptionalJson(path.join(metadataDirectory, "missions.json"));
const mapMetadata = await readOptionalJson(mapMetadataPath) ?? {zones: {}, missions: {}};
const missionIndex = indexById(metadata?.missions, "mission metadata");
const inputFiles = (await readdir(navmeshDirectory))
	.filter((fileName) => /^.+\.json$/i.test(fileName))
	.sort();

if (inputFiles.length === 0) {
	throw new Error(`No navmesh JSON files found in ${navmeshDirectory}.`);
}

const maps = [];
const missionIds = new Set();

for (const inputFileName of inputFiles) {
	const inputPath = path.join(navmeshDirectory, inputFileName);
	const source = await readFile(inputPath);
	const data = JSON.parse(source);
	const expectedInputFileName = `${sanitizeFileName(data.mission)}.json`;

	if (!data.mission) {
		throw new Error(`Navmesh file is missing mission id: ${inputFileName}.`);
	}

	if (inputFileName !== expectedInputFileName) {
		throw new Error(`Unexpected navmesh file name: ${inputFileName}. Expected ${expectedInputFileName}.`);
	}

	if (missionIds.has(data.mission)) {
		throw new Error(`Duplicate navmesh mission id: ${data.mission}.`);
	}

	missionIds.add(data.mission);

	const fileName = `${sanitizeFileName(data.mission)}.glb`;
	const mapMetadataEntry = buildMapMetadata(missionIndex.get(data.mission), mapMetadata);
	const outputPath = path.join(outputDirectory, fileName);
	const glb = createNavmeshGlb(data);
	const mainPath = await buildMainPathAsset(data.mission);

	await writeFile(outputPath, glb);

	maps.push({
		id: data.mission,
		file: `./data/${fileName}`,
		...mapMetadataEntry,
		bounds: data.bounds,
		stats: data.stats,
		sourceBytes: source.length,
		assetBytes: glb.length,
		landmarks: mainPath ? {mainPath} : {},
	});
}

const outputFiles = await readDirectoryIfExists(outputDirectory);
const expectedAssets = new Set(maps.map((map) => path.basename(map.file)));

for (const map of maps) {
	if (map.landmarks?.mainPath) {
		expectedAssets.add(path.basename(map.landmarks.mainPath.file));
	}
}

for (const outputFileName of outputFiles) {
	if (outputFileName.endsWith(".glb") && !expectedAssets.has(outputFileName)) {
		await rm(path.join(outputDirectory, outputFileName));
	}
}

await writeFile(
	path.join(outputDirectory, "maps.json"),
	`${JSON.stringify(compactObject({
		schemaVersion: 1,
		zones: Object.keys(mapMetadata.zones).length ? mapMetadata.zones : undefined,
		maps,
	}), null, "\t")}\n`,
);

for (const map of maps) {
	const reduction = ((1 - map.assetBytes / map.sourceBytes) * 100).toFixed(1);

	console.log(`${map.id}: ${map.sourceBytes} -> ${map.assetBytes} bytes (${reduction}% smaller)`);
}
