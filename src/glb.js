const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const FLOAT_COMPONENT_TYPE = 5126;
const UNSIGNED_SHORT_COMPONENT_TYPE = 5123;
const UNSIGNED_INT_COMPONENT_TYPE = 5125;

function typedArrayForAccessor(json, binary, accessorIndex) {
	const accessor = json.accessors[accessorIndex];
	const bufferView = json.bufferViews[accessor.bufferView];
	const byteOffset = binary.byteOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
	const components = accessor.type === "SCALAR" ? 1 : 3;

	if (accessor.componentType === FLOAT_COMPONENT_TYPE) {
		return new Float32Array(binary.buffer, byteOffset, accessor.count * components);
	}

	if (accessor.componentType === UNSIGNED_SHORT_COMPONENT_TYPE) {
		return new Uint16Array(binary.buffer, byteOffset, accessor.count);
	}

	if (accessor.componentType === UNSIGNED_INT_COMPONENT_TYPE) {
		return new Uint32Array(binary.buffer, byteOffset, accessor.count);
	}

	throw new Error(`Unsupported GLB component type: ${accessor.componentType}`);
}

export function parseGlb(arrayBuffer) {
	const view = new DataView(arrayBuffer);

	if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION) {
		throw new Error("Invalid GLB header.");
	}

	let offset = 12;
	let json;
	let binary;

	while (offset < arrayBuffer.byteLength) {
		const length = view.getUint32(offset, true);
		const type = view.getUint32(offset + 4, true);
		const chunk = new Uint8Array(arrayBuffer, offset + 8, length);

		if (type === JSON_CHUNK_TYPE) {
			json = JSON.parse(new TextDecoder().decode(chunk));
		} else if (type === BIN_CHUNK_TYPE) {
			binary = chunk;
		}

		offset += 8 + length;
	}

	if (!json || !binary) {
		throw new Error("GLB is missing its JSON or binary chunk.");
	}

	function parsePrimitive(primitive) {
		return {
			positions: typedArrayForAccessor(json, binary, primitive.attributes.POSITION),
			normals: Number.isInteger(primitive.attributes.NORMAL)
				? typedArrayForAccessor(json, binary, primitive.attributes.NORMAL)
				: null,
			colors: Number.isInteger(primitive.attributes.COLOR_0)
				? typedArrayForAccessor(json, binary, primitive.attributes.COLOR_0)
				: null,
			indices: typedArrayForAccessor(json, binary, primitive.indices),
		};
	}

	const primitives = json.meshes[0].primitives;
	const parts = {};

	for (const primitive of primitives) {
		if (primitive.extras?.part) {
			parts[primitive.extras.part] = parsePrimitive(primitive);
		}
	}

	if (Object.keys(parts).length > 0) {
		return {parts};
	}

	return parsePrimitive(primitives[0]);
}
