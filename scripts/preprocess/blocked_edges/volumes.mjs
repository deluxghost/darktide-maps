import {createComponents} from "./components.mjs";
import {distance2d, lerp, pointInPolygon2d, polygonDistance2d} from "./geometry.mjs";

export const EDGE_SAMPLE_AMOUNTS = [0.25, 0.5, 0.75];

const VOLUME_FILTER_MARGIN = 0.9;

function pointInVolume(point, entry) {
	const volume = entry.volume;

	if (!volume || !Array.isArray(volume.bottom_points) || volume.bottom_points.length < 3) {
		throw new Error("Blocked edge volume is missing a valid volume.");
	}

	return point[2] >= volume.altitude_min
		&& point[2] <= volume.altitude_max
		&& (
			pointInPolygon2d(point, volume.bottom_points)
			|| polygonDistance2d(point, volume.bottom_points) <= VOLUME_FILTER_MARGIN
		);
}

export function edgeIntersectsVolume(edge, volumes) {
	for (const amount of EDGE_SAMPLE_AMOUNTS) {
		const sample = lerp(edge.a, edge.b, amount);

		if (volumes.some((volume) => pointInVolume(sample, volume))) {
			return true;
		}
	}

	return false;
}

function positionNearMarker(position, marker) {
	const horizontal = distance2d(position, marker.position);
	const vertical = Math.abs(position[2] - marker.position[2]);

	return horizontal <= marker.distance
		&& vertical <= marker.distance;
}

function edgeIntersectsMarker(edge, markers) {
	for (const amount of EDGE_SAMPLE_AMOUNTS) {
		const sample = lerp(edge.a, edge.b, amount);

		if (markers.some((marker) => positionNearMarker(sample, marker))) {
			return true;
		}
	}

	return false;
}

export function filterVolumeEdges(edges, volumes) {
	if (volumes.length === 0) {
		return edges;
	}

	const components = createComponents(edges);
	const volumeComponents = new Set(components.filter((component) => (
		component.edges.some((edge) => edgeIntersectsVolume(edge, volumes))
	)));

	return components
		.filter((component) => !volumeComponents.has(component))
		.flatMap((component) => component.edges);
}

export function componentVolumeEdges(component, volumes) {
	return component.edges.filter((edge) => edgeIntersectsVolume(edge, volumes));
}

export function filterMarkerCollisionEdges(edges, markers) {
	if (markers.length === 0) {
		return edges;
	}

	return edges.filter((edge) => !edgeIntersectsMarker(edge, markers));
}
