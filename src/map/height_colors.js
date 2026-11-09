import { APP_CONFIG } from "../config.js";

const HEIGHT_COLORS = APP_CONFIG.runtime.visual.navmesh.heightColors;

function interpolateHeightColor(ratio) {
	const scaled = Math.min(Math.max(ratio, 0), 1) * (HEIGHT_COLORS.length - 1);
	const index = Math.min(Math.floor(scaled), HEIGHT_COLORS.length - 2);
	const amount = scaled - index;
	return HEIGHT_COLORS[index].map((value, channel) =>
		value + (HEIGHT_COLORS[index + 1][channel] - value) * amount);
}

function colorStop({position, ratio}) {
	const color = interpolateHeightColor(ratio).map(Math.round).join(" ");
	return `rgb(${color}) ${position * 100}%`;
}

function layerGradient(layers, minimum, maximum) {
	const anchors = [{position: 0, ratio: minimum}];
	for (const [index, samples] of layers.entries()) {
		if (!samples.length) throw new Error(`Cannot color an empty map layer: ${index}`);
		const middle = Math.floor(samples.length / 2);
		const ratio = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
		anchors.push({position: (index + 0.5) / layers.length, ratio});
	}
	anchors.push({position: 1, ratio: maximum});
	const stops = [];
	for (let index = 1; index < anchors.length; index++) {
		const start = anchors[index - 1], end = anchors[index];
		const samples = [start];
		if (end.ratio !== start.ratio) {
			for (let color = 1; color < HEIGHT_COLORS.length - 1; color++) {
				const ratio = color / (HEIGHT_COLORS.length - 1);
				const t = (ratio - start.ratio) / (end.ratio - start.ratio);
				if (t > 0 && t < 1) samples.push({position: start.position + t * (end.position - start.position), ratio});
			}
		}
		samples.sort((left, right) => left.position - right.position);
		stops.push(...samples.map(colorStop));
	}
	stops.push(colorStop(anchors.at(-1)));
	return `linear-gradient(to top, ${stops.join(", ")})`;
}

// Ignore unused vertices when computing the current view's height percentiles.
export function createHeightColors(glb, layerCount) {
	const {positions, floorIds, indices} = glb;
	const order = [...new Set(indices)].sort((left, right) => positions[left * 3 + 2] - positions[right * 3 + 2]);
	const colors = new Float32Array(positions.length);
	const layers = Array.from({length: layerCount}, () => []);
	let minimum = 0, maximum = 0;
	for (let start = 0; start < order.length;) {
		let end = start + 1;
		while (end < order.length && positions[order[start] * 3 + 2] === positions[order[end] * 3 + 2]) end++;
		// Equal heights keep the same upper percentile used by the map's existing palette.
		const ratio = order.length > 1 ? (end - 1) / (order.length - 1) : 0;
		const color = interpolateHeightColor(ratio).map(value => value / 255);
		if (start === 0) minimum = ratio;
		maximum = ratio;
		for (let index = start; index < end; index++) {
			const vertex = order[index];
			colors.set(color, vertex * 3);
			layers[Math.floor(floorIds[vertex])].push(ratio);
		}
		start = end;
	}
	return {colors, gradient: layerGradient(layers, minimum, maximum)};
}
