import {BUILD_CONFIG} from "../config.mjs";
import {summarizePartition} from "./regions.mjs";

const CONFIG = BUILD_CONFIG.floors;
const MAXIMUM_MAP_SHARE = 0.05;

function minimumOcclusionArea(graph) {
	return Math.min(graph.stats.originalArea * MAXIMUM_MAP_SHARE, Math.max(CONFIG.minimumLayerOcclusionArea, Math.min(
		CONFIG.maximumLayerOcclusionArea,
		graph.stats.originalArea * CONFIG.minimumLayerOcclusionShare,
	)));
}

export function coalesceDisplayFloors(graph, occlusion, partition) {
	const minimumArea = minimumOcclusionArea(graph);
	const groups = partition.levels.map((_, floor) => ({floors: [floor], area: 0}));
	for (let n = 0; n < graph.nodes.length; n++) {
		const node = graph.nodes[n], group = groups[partition.labels[n]];
		group.area += node.area;
	}
	const costs = [...graph.edgeCosts].map(([key, cost]) => ({nodes: key.split(":").map(Number), cost}));
	costs.push(...graph.affinities);
	const merged = [];
	while (groups.length > 1) {
		const labels = new Map(groups.flatMap((group, i) => group.floors.map(floor => [floor, i])));
		const floorOf = n => labels.get(partition.labels[n]);
		const boundaries = Array.from({length: groups.length - 1}, (_, i) => ({i, overlap: 0, connection: 0}));
		for (const [key, area] of occlusion.relations) {
			const [a, b] = key.split(":").map(Number).map(floorOf);
			if (b === a + 1) boundaries[a].overlap += area;
		}
		for (const {nodes: [a, b], cost} of costs) {
			const left = floorOf(a), right = floorOf(b);
			if (Math.abs(left - right) === 1) boundaries[Math.min(left, right)].connection += cost;
		}
		// An extra slider interval must remove meaningful occlusion, not merely contain high surfaces.
		const candidates = boundaries.filter(boundary => boundary.overlap <= minimumArea);
		candidates.sort((a, b) => a.overlap - b.overlap || b.connection - a.connection);
		if (!candidates.length) break;
		const {i, overlap} = candidates[0], target = groups[i], source = groups[i + 1];
		merged.push({floors: [...source.floors], into: [...target.floors], area: source.area, overlap});
		target.floors.push(...source.floors);
		target.area += source.area;
		groups.splice(i + 1, 1);
	}
	const displayOf = new Map(groups.flatMap((group, i) => group.floors.map(floor => [floor, i])));
	const labels = Int32Array.from(partition.labels, floor => displayOf.get(floor));
	let mergedOcclusionArea = 0;
	for (const [key, area] of occlusion.relations) {
		const [a, b] = key.split(":").map(Number);
		if (labels[a] > labels[b]) throw new Error("Display layer coalescing reversed occlusion order");
		if (labels[a] === labels[b]) mergedOcclusionArea += area;
	}
	const summary = summarizePartition(graph, labels);
	return {...partition, ...summary, labels, stats: {...partition.stats,
		logicalFloors: partition.levels.length, regions: summary.regions.length,
		minimumOcclusionArea: minimumArea, displayAreas: groups.map(group => group.area),
		mergedFloorBoundaries: merged.length, mergedOcclusionArea, mergedFloorGroups: merged,
	}};
}
