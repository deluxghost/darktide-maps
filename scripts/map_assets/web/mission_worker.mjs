import path from "node:path";
import {parentPort, workerData} from "node:worker_threads";
import {buildMissionAssets} from "./assets.mjs";
import {createGameTextRegistry} from "./game_text.mjs";
import {readJson} from "./utils.mjs";

// One mission per worker thread. Game text keys are content hashes, so the texts this mission registers merge into
// the main registry independently of build order.
const {work, outputDirectory, zones, id} = workerData;
const packet = await readJson(path.join(work, "missions", `${id}.json`));
if (packet.id !== id) throw new Error(`Mission packet mismatch: ${id}`);
const gameText = createGameTextRegistry();
const map = await buildMissionAssets(packet, {outputDirectory, gameText, zones});
parentPort.postMessage({manifest: map.manifest, id: map.data.id, assetBytes: map.assetBytes, report: map.report,
	texts: Object.values(gameText.data())});
