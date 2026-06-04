import {mkdir, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {buildMissionAssets, removeStaleAssets} from "./assets.mjs";
import {compactObject, indexById, readOptionalJson} from "./utils.mjs";

const inputDirectory = process.argv[2];
const outputDirectory = process.argv[3] ?? path.resolve("public", "data");
const directories = {
	navmesh: inputDirectory && path.join(inputDirectory, "navmesh"),
	mainPath: inputDirectory && path.join(inputDirectory, "main_path"),
	markers: inputDirectory && path.join(inputDirectory, "markers"),
	metadata: inputDirectory && path.join(inputDirectory, "metadata"),
};
const mapMetadataPath = path.resolve("metadata", "map.json");
const markerMetadataPath = path.resolve("metadata", "markers.json");

if (!inputDirectory) {
	throw new Error("Usage: node scripts/preprocess/index.mjs <nav-exporter-directory> [output-directory]");
}

await mkdir(outputDirectory, {recursive: true});

const metadata = await readOptionalJson(path.join(directories.metadata, "missions.json"));
const mapMetadata = await readOptionalJson(mapMetadataPath) ?? {zones: {}, missions: {}};
const markerMetadata = await readOptionalJson(markerMetadataPath) ?? {overrides: {}};
const missionIndex = indexById(metadata?.missions, "mission metadata");
const inputFiles = (await readdir(directories.navmesh))
	.filter((fileName) => /^.+\.json$/i.test(fileName))
	.sort();

if (inputFiles.length === 0) {
	throw new Error(`No navmesh JSON files found in ${directories.navmesh}.`);
}

const context = {
	directories,
	outputDirectory,
	mapMetadata,
	markerMetadata,
	missionIndex,
	missionIds: new Set(),
};
const maps = [];

for (const inputFileName of inputFiles) {
	maps.push(await buildMissionAssets(inputFileName, context));
}

await removeStaleAssets(outputDirectory, maps);
await writeFile(
	path.join(outputDirectory, "maps.json"),
	`${JSON.stringify(compactObject({
		schemaVersion: 1,
		dataUpdatedAtUnix: Math.floor(Date.now() / 1000),
		zones: Object.keys(mapMetadata.zones).length ? mapMetadata.zones : undefined,
		maps: maps.map((map) => map.manifest),
	}), null, "\t")}\n`,
);

for (const map of maps) {
	const reduction = ((1 - map.assetBytes / map.sourceBytes) * 100).toFixed(1);

	console.log(`${map.data.id}: ${map.sourceBytes} -> ${map.assetBytes} bytes (${reduction}% smaller)`);
}
