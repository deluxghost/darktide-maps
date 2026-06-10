const POSITION_COMPONENTS = 3;

function nullableText(value) {
	const text = value?.trim();

	return text ? text : null;
}

export function tryParsePositionParameter(value) {
	const text = nullableText(value);

	if (!text) {
		return null;
	}

	const normalized = text.replace(/^\[/, "").replace(/\]$/, "");
	const parts = normalized.split(",").map((part) => Number(part.trim()));

	if (parts.length !== POSITION_COMPONENTS || !parts.every(Number.isFinite)) {
		return null;
	}

	return parts;
}

export function readLocationRequest(source = window.location.href) {
	const url = new URL(source);
	const params = locationParams(url);

	return {
		mapId: nullableText(params.get("map")),
		markerId: nullableText(params.get("marker")),
		positionText: nullableText(params.get("position")),
	};
}

function currentUrl() {
	return new URL(window.location.href);
}

function locationParams(url) {
	return new URLSearchParams(url.hash.replace(/^#/, ""));
}

function writeLocationParams(url, params) {
	url.hash = params.toString();
}

function setMapParameter(params, mapId) {
	params.set("map", mapId);
}

function clearLocationParameters(params) {
	params.delete("marker");
	params.delete("position");
}

export function mapLocationUrl(mapId) {
	const url = currentUrl();
	const params = locationParams(url);

	setMapParameter(params, mapId);
	clearLocationParameters(params);
	writeLocationParams(url, params);

	return url;
}

export function markerLocationUrl(mapId, markerId) {
	const url = currentUrl();
	const params = locationParams(url);

	setMapParameter(params, mapId);
	params.set("marker", markerId);
	params.delete("position");
	writeLocationParams(url, params);

	return url;
}

export function pushUrl(url) {
	window.history.pushState(null, "", url);
}

export function replaceUrl(url) {
	window.history.replaceState(null, "", url);
}
