import {mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const FLOAT_COMPONENT_TYPE = 5126;
const UNSIGNED_SHORT_COMPONENT_TYPE = 5123;
const UNSIGNED_INT_COMPONENT_TYPE = 5125;
const ARRAY_BUFFER_TARGET = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET = 34963;

const inputDirectory = process.argv[2];
const outputDirectory = process.argv[3] ?? path.resolve("public", "data");
const navmeshDirectory = inputDirectory && path.join(inputDirectory, "navmesh");

if (!inputDirectory) {
	throw new Error("Usage: node scripts/build-nav-assets.mjs <nav-exporter-directory> [output-directory]");
}

function align4(value) {
	return (value + 3) & ~3;
}

function sanitizeFileName(value) {
	return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

function writeChunk(target, offset, type, content, paddingByte) {
	const paddedLength = align4(content.length);

	target.writeUInt32LE(paddedLength, offset);
	target.writeUInt32LE(type, offset + 4);
	content.copy(target, offset + 8);
	target.fill(paddingByte, offset + 8 + content.length, offset + 8 + paddedLength);

	return offset + 8 + paddedLength;
}

function createGlb(data) {
	const positions = new Float32Array(data.vertices.length * 3);

	for (let index = 0; index < data.vertices.length; index++) {
		positions.set(data.vertices[index], index * 3);
	}

	const useUint32 = data.vertices.length > 65535;
	const IndexArray = useUint32 ? Uint32Array : Uint16Array;
	const indices = new IndexArray(data.triangles.length * 3);

	for (let index = 0; index < data.triangles.length; index++) {
		const triangle = data.triangles[index];

		indices.set([triangle[0] - 1, triangle[1] - 1, triangle[2] - 1], index * 3);
	}

	const positionBuffer = Buffer.from(positions.buffer);
	const indexBuffer = Buffer.from(indices.buffer);
	const indexOffset = align4(positionBuffer.length);
	const binaryLength = align4(indexOffset + indexBuffer.length);
	const binary = Buffer.alloc(binaryLength);

	positionBuffer.copy(binary);
	indexBuffer.copy(binary, indexOffset);

	const gltf = {
		asset: {
			version: "2.0",
			generator: "darktide-maps build-nav-assets",
		},
		scene: 0,
		scenes: [{nodes: [0]}],
		nodes: [{mesh: 0, name: data.mission}],
		meshes: [{
			name: data.mission,
			primitives: [{
				attributes: {POSITION: 0},
				indices: 1,
				mode: 4,
			}],
		}],
		buffers: [{byteLength: binary.length}],
		bufferViews: [
			{
				buffer: 0,
				byteOffset: 0,
				byteLength: positionBuffer.length,
				target: ARRAY_BUFFER_TARGET,
			},
			{
				buffer: 0,
				byteOffset: indexOffset,
				byteLength: indexBuffer.length,
				target: ELEMENT_ARRAY_BUFFER_TARGET,
			},
		],
		accessors: [
			{
				bufferView: 0,
				componentType: FLOAT_COMPONENT_TYPE,
				count: data.vertices.length,
				type: "VEC3",
				min: data.bounds.min,
				max: data.bounds.max,
			},
			{
				bufferView: 1,
				componentType: useUint32 ? UNSIGNED_INT_COMPONENT_TYPE : UNSIGNED_SHORT_COMPONENT_TYPE,
				count: indices.length,
				type: "SCALAR",
			},
		],
		extras: {
			schemaVersion: data.schema_version,
			tiles: data.stats.tiles,
		},
	};
	const json = Buffer.from(JSON.stringify(gltf));
	const file = Buffer.alloc(12 + 8 + align4(json.length) + 8 + align4(binary.length));

	file.writeUInt32LE(GLB_MAGIC, 0);
	file.writeUInt32LE(GLB_VERSION, 4);
	file.writeUInt32LE(file.length, 8);

	let offset = 12;

	offset = writeChunk(file, offset, JSON_CHUNK_TYPE, json, 0x20);
	writeChunk(file, offset, BIN_CHUNK_TYPE, binary, 0x00);

	return file;
}

await mkdir(outputDirectory, {recursive: true});

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
	const outputPath = path.join(outputDirectory, fileName);
	const glb = createGlb(data);

	await writeFile(outputPath, glb);

	maps.push({
		id: data.mission,
		file: `./data/${fileName}`,
		bounds: data.bounds,
		stats: data.stats,
		sourceBytes: source.length,
		assetBytes: glb.length,
	});
}

const outputFiles = await readdir(outputDirectory);
const expectedAssets = new Set(maps.map((map) => path.basename(map.file)));

for (const outputFileName of outputFiles) {
	if (outputFileName.endsWith(".glb") && !expectedAssets.has(outputFileName)) {
		await rm(path.join(outputDirectory, outputFileName));
	}
}

await writeFile(
	path.join(outputDirectory, "maps.json"),
	`${JSON.stringify({schemaVersion: 1, maps}, null, "\t")}\n`,
);

for (const map of maps) {
	const reduction = ((1 - map.assetBytes / map.sourceBytes) * 100).toFixed(1);

	console.log(`${map.id}: ${map.sourceBytes} -> ${map.assetBytes} bytes (${reduction}% smaller)`);
}
