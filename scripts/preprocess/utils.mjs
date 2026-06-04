import {createHash} from "node:crypto";
import {readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";

export function arrayFromLuaJson(value, label) {
	if (Array.isArray(value)) {
		return value;
	}

	if (value && typeof value === "object" && Object.keys(value).length === 0) {
		return [];
	}

	throw new Error(`${label} must be an array.`);
}

export function compactObject(value) {
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

export async function directoryFileBytes(directory) {
	const entries = await readdir(directory, {withFileTypes: true});
	let total = 0;

	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}

		const file = await stat(path.join(directory, entry.name));

		total += file.size;
	}

	return total;
}

export function indexById(items, sourceName) {
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

export async function readDirectoryIfExists(directory) {
	try {
		return await readdir(directory);
	} catch (error) {
		if (error.code === "ENOENT") {
			return [];
		}

		throw error;
	}
}

export async function readOptionalFile(filePath) {
	try {
		return await readFile(filePath);
	} catch (error) {
		if (error.code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

export async function readOptionalJson(filePath) {
	const source = await readOptionalFile(filePath);

	return source ? JSON.parse(source) : null;
}

export function sanitizeFileName(value) {
	return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function stableHash(value) {
	return createHash("sha1").update(value).digest("hex").slice(0, 12);
}
