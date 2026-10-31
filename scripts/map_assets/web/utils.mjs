import {createHash} from "node:crypto";
import {readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";

export function requireArray(value, label) {
	if (Array.isArray(value)) {
		return value;
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

export async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

export function sanitizeFileName(value) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid mission id: ${value}`);
	return value;
}

export function stableHash(value) {
	return createHash("sha1").update(value).digest("hex").slice(0, 12);
}
