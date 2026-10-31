import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {buildMissionAssets, removeStaleAssets} from "./assets.mjs";
import {compactObject, readJson} from "./utils.mjs";
import {verifyFloorDependencies} from "./floors/ordered_cut.mjs";
import {createGameTextRegistry} from "./game_text.mjs";
import {validateAssets} from "./validate.mjs";

const [work, outputDirectory] = process.argv.slice(2);
if (!work || !outputDirectory) throw new Error("Missing internal map build directories");
verifyFloorDependencies();
const plan = await readJson(path.join(work, "build.json"));
if (plan.format !== "static-map-build-v2") throw new Error("Invalid map build plan");
await mkdir(outputDirectory, {recursive: true});
const maps = [], reports = [];
const gameText = createGameTextRegistry();
for (const {id} of [...plan.missions].sort((a, b) => a.id.localeCompare(b.id))) {
	const packet = await readJson(path.join(work, "missions", `${id}.json`));
	if (packet.id !== id) throw new Error(`Mission packet mismatch: ${id}`);
	const map = await buildMissionAssets(packet, {outputDirectory, gameText, zones: plan.zones});
	maps.push(map);
	reports.push(map.report);
	console.log(`${id}: ${map.assetBytes} bytes; ${map.report.floors.layers.length} layers`);
}
for (const locale of ["en", "zh-cn"]) {
	const names = maps.map(({manifest}) => `${manifest.zone}:${manifest.title[locale]}`);
	if (new Set(names).size !== names.length) throw new Error(`Ambiguous map names in ${locale}`);
}
await removeStaleAssets(outputDirectory, maps);
await writeFile(path.join(work, "geometry_report.json"), `${JSON.stringify(reports)}\n`);
const manifest = gameText.pack(compactObject({
	schemaVersion: 1,
	gameText: "./data/game-text.json",
	dataUpdatedAtUnix: Math.floor(Date.now() / 1000),
	zones: plan.zones,
	source: plan.source,
	maps: maps.map(map => map.manifest),
}));
await writeFile(path.join(outputDirectory, "game-text.json"), `${JSON.stringify(gameText.data())}\n`);
await writeFile(path.join(outputDirectory, "maps.json"), `${JSON.stringify(manifest)}\n`);
validateAssets(outputDirectory);
