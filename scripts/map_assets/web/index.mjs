import {mkdir, writeFile} from "node:fs/promises";
import {availableParallelism} from "node:os";
import path from "node:path";
import {Worker} from "node:worker_threads";
import {removeStaleAssets} from "./assets.mjs";
import {compactObject, readJson} from "./utils.mjs";
import {verifyFloorDependencies} from "./floors/ordered_cut.mjs";
import {createGameTextRegistry} from "./game_text.mjs";
import {validateAssets} from "./validate.mjs";
import {validateMarkerConfiguration} from "./marker_overrides.mjs";

const [work, outputDirectory, workerArgument] = process.argv.slice(2);
if (!work || !outputDirectory) throw new Error("Missing internal map build directories");
verifyFloorDependencies();
const plan = await readJson(path.join(work, "build.json"));
if (plan.format !== "static-map-build-v2") throw new Error("Invalid map build plan");
validateMarkerConfiguration(plan.missions.map((mission) => mission.id), plan.markerLabels);
await mkdir(outputDirectory, {recursive: true});
const gameText = createGameTextRegistry();
const ids = plan.missions.map(({id}) => id).sort((a, b) => a.localeCompare(b));

function buildMission(id) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./mission_worker.mjs", import.meta.url),
			{workerData: {work, outputDirectory, zones: plan.zones, id}});
		let result = null;
		worker.once("message", (message) => { result = message; });
		worker.once("error", reject);
		worker.once("exit", (code) => code === 0 && result ? resolve(result)
			: reject(new Error(`${id}: web build worker exited with code ${code}`)));
	});
}

// missions build in parallel worker threads; results are merged in id order
const results = new Map();
let next = 0;
async function runWorker() {
	while (next < ids.length) {
		const id = ids[next++];
		const map = await buildMission(id);
		results.set(id, map);
		console.log(`${id}: ${map.assetBytes} bytes; ${map.report.floors.layers.length} layers`);
	}
}
const workerCount = Math.max(1, Math.min(ids.length, Number(workerArgument) || availableParallelism()));
await Promise.all(Array.from({length: workerCount}, runWorker));
const maps = ids.map((id) => results.get(id));
const reports = maps.map((map) => map.report);
for (const map of maps) {
	for (const text of map.texts) gameText.pack(text);
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
	markerLabels: plan.markerLabels,
	dataUpdatedAtUnix: Math.floor(Date.now() / 1000),
	zones: plan.zones,
	source: plan.source,
	maps: maps.map(map => map.manifest),
}));
await writeFile(path.join(outputDirectory, "game-text.json"), `${JSON.stringify(gameText.data())}\n`);
await writeFile(path.join(outputDirectory, "maps.json"), `${JSON.stringify(manifest)}\n`);
await validateAssets(outputDirectory);
