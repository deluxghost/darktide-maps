export function readStoredObject(key) {
	return JSON.parse(localStorage.getItem(key) ?? "{}");
}

export function writeStoredObject(key, value) {
	localStorage.setItem(key, JSON.stringify(value));
}

export function writeStoredProperty(key, property, value) {
	const stored = readStoredObject(key);

	stored[property] = value;
	writeStoredObject(key, stored);
}
