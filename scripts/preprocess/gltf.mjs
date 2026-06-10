const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const FLOAT_COMPONENT_TYPE = 5126;
const UNSIGNED_SHORT_COMPONENT_TYPE = 5123;
const UNSIGNED_INT_COMPONENT_TYPE = 5125;
const ARRAY_BUFFER_TARGET = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET = 34963;
const TRIANGLES_MODE = 4;
const LINES_MODE = 1;

function align4(value) {
	return (value + 3) & ~3;
}

function writeChunk(target, offset, type, content, paddingByte) {
	const paddedLength = align4(content.length);

	target.writeUInt32LE(paddedLength, offset);
	target.writeUInt32LE(type, offset + 4);
	content.copy(target, offset + 8);
	target.fill(paddingByte, offset + 8 + content.length, offset + 8 + paddedLength);

	return offset + 8 + paddedLength;
}

function createGlbFile(gltf, binary) {
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

function boundsForPositions(positions) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];

	for (let index = 0; index < positions.length; index += 3) {
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], positions[index + axis]);
			max[axis] = Math.max(max[axis], positions[index + axis]);
		}
	}

	return {min, max};
}

function baseGltf(name, binary, extras) {
	return {
		asset: {
			version: "2.0",
			generator: "darktide-maps preprocess",
		},
		scene: 0,
		scenes: [{nodes: [0]}],
		nodes: [{mesh: 0, name}],
		meshes: [],
		buffers: [{byteLength: binary.length}],
		bufferViews: [],
		accessors: [],
		extras,
	};
}

export function createNavmeshGlb(data) {
	const positions = new Float32Array(data.vertices.length * 3);

	for (let index = 0; index < data.vertices.length; index++) {
		positions.set(data.vertices[index], index * 3);
	}

	const useUint32 = data.vertices.length > 65535;
	const IndexArray = useUint32 ? Uint32Array : Uint16Array;
	const indices = new IndexArray(data.triangles.length * 3);

	for (let index = 0; index < data.triangles.length; index++) {
		const triangle = data.triangles[index];

		indices.set(triangle.slice(0, 3).map((vertexIndex) => vertexIndex - 1), index * 3);
	}

	const positionBuffer = Buffer.from(positions.buffer);
	const indexBuffer = Buffer.from(indices.buffer);
	const indexOffset = align4(positionBuffer.length);
	const binaryLength = align4(indexOffset + indexBuffer.length);
	const binary = Buffer.alloc(binaryLength);
	const gltf = baseGltf(data.mission, binary, {
		schemaVersion: data.schema_version,
		tiles: data.stats.tiles,
	});

	positionBuffer.copy(binary);
	indexBuffer.copy(binary, indexOffset);

	gltf.meshes.push({
		name: data.mission,
		primitives: [{
			attributes: {POSITION: 0},
			indices: 1,
			mode: TRIANGLES_MODE,
		}],
	});
	gltf.bufferViews.push(
		{buffer: 0, byteOffset: 0, byteLength: positionBuffer.length, target: ARRAY_BUFFER_TARGET},
		{buffer: 0, byteOffset: indexOffset, byteLength: indexBuffer.length, target: ELEMENT_ARRAY_BUFFER_TARGET},
	);
	gltf.accessors.push(
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
	);

	return createGlbFile(gltf, binary);
}

function appendAligned(chunks, buffer) {
	const offset = chunks.reduce((sum, chunk) => align4(sum + chunk.length), 0);

	chunks.push(buffer);

	return offset;
}

export function createGeometryPartsGlb(name, parts, extras) {
	const chunks = [];
	const gltf = {
		asset: {
			version: "2.0",
			generator: "darktide-maps preprocess",
		},
		scene: 0,
		scenes: [{nodes: [0]}],
		nodes: [{mesh: 0, name}],
		meshes: [{
			name,
			primitives: [],
		}],
		buffers: [],
		bufferViews: [],
		accessors: [],
		extras,
	};

	for (const [part, mesh] of Object.entries(parts)) {
		if (mesh.indices.length === 0) {
			continue;
		}

		const positions = new Float32Array(mesh.positions);
		const normals = new Float32Array(mesh.normals);
		const useUint32 = positions.length / 3 > 65535;
		const IndexArray = useUint32 ? Uint32Array : Uint16Array;
		const indices = new IndexArray(mesh.indices);
		const positionBuffer = Buffer.from(positions.buffer);
		const normalBuffer = Buffer.from(normals.buffer);
		const indexBuffer = Buffer.from(indices.buffer);
		const positionOffset = appendAligned(chunks, positionBuffer);
		const normalOffset = appendAligned(chunks, normalBuffer);
		const indexOffset = appendAligned(chunks, indexBuffer);
		const bounds = boundsForPositions(mesh.positions);
		const positionView = gltf.bufferViews.length;
		const normalView = positionView + 1;
		const indexView = positionView + 2;
		const positionAccessor = gltf.accessors.length;
		const normalAccessor = positionAccessor + 1;
		const indexAccessor = positionAccessor + 2;

		gltf.bufferViews.push(
			{buffer: 0, byteOffset: positionOffset, byteLength: positionBuffer.length, target: ARRAY_BUFFER_TARGET},
			{buffer: 0, byteOffset: normalOffset, byteLength: normalBuffer.length, target: ARRAY_BUFFER_TARGET},
			{buffer: 0, byteOffset: indexOffset, byteLength: indexBuffer.length, target: ELEMENT_ARRAY_BUFFER_TARGET},
		);
		gltf.accessors.push(
			{
				bufferView: positionView,
				componentType: FLOAT_COMPONENT_TYPE,
				count: positions.length / 3,
				type: "VEC3",
				min: bounds.min,
				max: bounds.max,
			},
			{
				bufferView: normalView,
				componentType: FLOAT_COMPONENT_TYPE,
				count: normals.length / 3,
				type: "VEC3",
			},
			{
				bufferView: indexView,
				componentType: useUint32 ? UNSIGNED_INT_COMPONENT_TYPE : UNSIGNED_SHORT_COMPONENT_TYPE,
				count: indices.length,
				type: "SCALAR",
			},
		);
		gltf.meshes[0].primitives.push({
			attributes: {POSITION: positionAccessor, NORMAL: normalAccessor},
			indices: indexAccessor,
			mode: TRIANGLES_MODE,
			extras: {part},
		});
	}

	const binaryLength = chunks.reduce((sum, chunk) => align4(sum + chunk.length), 0);
	const binary = Buffer.alloc(binaryLength);
	let offset = 0;

	for (const chunk of chunks) {
		chunk.copy(binary, offset);
		offset = align4(offset + chunk.length);
	}

	gltf.buffers.push({byteLength: binary.length});

	return createGlbFile(gltf, binary);
}

export function createPathLinesGlb(name, paths, extras) {
	const pathLengths = paths.map((path) => path.length);
	const vertexCount = pathLengths.reduce((sum, length) => sum + length, 0);
	const indexCount = pathLengths.reduce((sum, length) => sum + Math.max(0, length - 1) * 2, 0);

	if (vertexCount === 0 || indexCount === 0) {
		throw new Error(`Path line asset ${name} has no renderable paths.`);
	}

	const positions = new Float32Array(vertexCount * 3);
	const useUint32 = vertexCount > 65535;
	const IndexArray = useUint32 ? Uint32Array : Uint16Array;
	const indices = new IndexArray(indexCount);
	let vertexOffset = 0;
	let indexOffset = 0;

	for (const path of paths) {
		const pathVertexOffset = vertexOffset;

		for (const point of path) {
			positions.set(point, vertexOffset * 3);
			vertexOffset++;
		}

		for (let index = 0; index < path.length - 1; index++) {
			indices[indexOffset++] = pathVertexOffset + index;
			indices[indexOffset++] = pathVertexOffset + index + 1;
		}
	}

	const positionBuffer = Buffer.from(positions.buffer);
	const indexBuffer = Buffer.from(indices.buffer);
	const indexByteOffset = align4(positionBuffer.length);
	const binaryLength = align4(indexByteOffset + indexBuffer.length);
	const binary = Buffer.alloc(binaryLength);
	const bounds = boundsForPositions(positions);
	const gltf = baseGltf(name, binary, {
		...extras,
		pathLengths,
	});

	positionBuffer.copy(binary);
	indexBuffer.copy(binary, indexByteOffset);

	gltf.meshes.push({
		name,
		primitives: [{
			attributes: {POSITION: 0},
			indices: 1,
			mode: LINES_MODE,
		}],
	});
	gltf.bufferViews.push(
		{buffer: 0, byteOffset: 0, byteLength: positionBuffer.length, target: ARRAY_BUFFER_TARGET},
		{buffer: 0, byteOffset: indexByteOffset, byteLength: indexBuffer.length, target: ELEMENT_ARRAY_BUFFER_TARGET},
	);
	gltf.accessors.push(
		{
			bufferView: 0,
			componentType: FLOAT_COMPONENT_TYPE,
			count: vertexCount,
			type: "VEC3",
			min: bounds.min,
			max: bounds.max,
		},
		{
			bufferView: 1,
			componentType: useUint32 ? UNSIGNED_INT_COMPONENT_TYPE : UNSIGNED_SHORT_COMPONENT_TYPE,
			count: indices.length,
			type: "SCALAR",
		},
	);

	return createGlbFile(gltf, binary);
}
