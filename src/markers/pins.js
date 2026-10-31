export function viewDepth(pin, viewport) {
	const position = pin.position;
	const matrix = viewport.viewMatrix;

	return matrix[2] * position[0] + matrix[6] * position[1] + matrix[10] * position[2] + matrix[14];
}

function pinFloorIndex(pin) {
	return pin.markerType === "auxiliary_pin"
		? pin.parentMarker?.floorIndex
		: pin.floorIndex;
}

export function pinInFloorRange(pin, range) {
	if (!range) {
		return true;
	}

	if (pin.markerType === "position_marker") {
		return true;
	}

	const floorIndex = pinFloorIndex(pin);

	return Number.isInteger(floorIndex) && floorIndex >= range[0] && floorIndex < range[1];
}

export function sortedPins(pins, visibleCategories, viewport, floorRange) {
	const visiblePins = pins.filter((pin) => (
		visibleCategories.has(pin.category)
		|| pin.markerType === "auxiliary_pin"
		|| pin.markerType === "position_marker"
	) && pinInFloorRange(pin, floorRange));

	if (!viewport) {
		return visiblePins;
	}

	return visiblePins
		.map((pin, index) => ({
			pin,
			index,
			depth: viewDepth(pin, viewport),
		}))
		.sort((left, right) => left.depth - right.depth || left.index - right.index)
		.map((entry) => entry.pin);
}

export function auxiliaryPinsForMarker(marker) {
	return (marker?.auxiliaryMarkers ?? []).map((auxiliary) => ({
		...auxiliary,
		category: auxiliary.category ?? marker.category,
		markerType: "auxiliary_pin",
		parentMarker: marker,
	}));
}
