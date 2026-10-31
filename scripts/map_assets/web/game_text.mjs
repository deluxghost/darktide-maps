import {stableHash} from "./utils.mjs";

export function createGameTextRegistry() {
	const texts = new Map();
	function pack(value) {
		if (Array.isArray(value)) return value.map(pack);
		if (!value || typeof value !== "object") return value;
		if (Object.hasOwn(value, "en")) {
			if (Object.values(value).some(text => typeof text !== "string")) {
				throw new Error("Invalid localized game text");
			}
			const text = Object.fromEntries(Object.keys(value).sort().map(locale => [locale, value[locale]]));
			const signature = JSON.stringify(text), key = stableHash(signature);
			if (texts.has(key) && JSON.stringify(texts.get(key)) !== signature) {
				throw new Error(`Game text hash collision: ${key}`);
			}
			texts.set(key, text);
			return {gameText: key};
		}
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pack(entry)]));
	}
	return {pack, data: () => Object.fromEntries([...texts].sort(([left], [right]) => left.localeCompare(right)))};
}
