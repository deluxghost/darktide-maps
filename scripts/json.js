export function arrayFromLuaJson(value, label) {
	if (Array.isArray(value)) {
		return value;
	}

	if (value && typeof value === "object" && Object.keys(value).length === 0) {
		return [];
	}

	throw new Error(`${label} must be an array.`);
}
