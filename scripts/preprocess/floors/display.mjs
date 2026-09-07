import {minimumDisplayArea} from "./attachments.mjs";
import {summarizePartition} from "./regions.mjs";

export function coalesceDisplayFloors(graph, occlusion, partition) {
	const minimumArea = minimumDisplayArea(graph);
	const groups = partition.levels.map((_, floor) => ({floors: [floor], area: 0, height: 0}));
	for (let n = 0; n < graph.nodes.length; n++) {
		const node = graph.nodes[n], group = groups[partition.labels[n]];
		group.area += node.area;
		group.height += node.area * (graph.base + (node.band + 0.5) * graph.step);
	}
	const costs = [...graph.edgeCosts].map(([key, cost]) => ({nodes: key.split(":").map(Number), cost}));
	costs.push(...(graph.affinities ?? []));
	const merged = [];
	while (groups.length > 1) {
		const labels = new Map(groups.flatMap((group, i) => group.floors.map(floor => [floor, i])));
		const floorOf = n => labels.get(partition.labels[n]);
		const sparse = groups.map((group, i) => ({group, i})).filter(({group}) => group.area < minimumArea).sort((a, b) => a.group.area - b.group.area);
		let choice;
		for (const {group, i} of sparse) {
			const candidates = [i - 1, i + 1].filter(j => j >= 0 && j < groups.length).map(j => {
				let connection = 0, overlap = 0;
				const crosses = (a, b) => (floorOf(a) === i && floorOf(b) === j) || (floorOf(a) === j && floorOf(b) === i);
				for (const {nodes: [a, b], cost} of costs) if (crosses(a, b)) connection += cost;
				for (const [key, area] of occlusion.relations) if (crosses(...key.split(":").map(Number))) overlap += area;
				return {i, j, connection, overlap, height: Math.abs(group.height / group.area - groups[j].height / groups[j].area)};
			}).filter(candidate => candidate.overlap <= minimumArea);
			candidates.sort((a, b) => b.connection - a.connection || a.overlap - b.overlap || a.height - b.height);
			if (candidates.length) { choice = candidates[0]; break; }
		}
		if (!choice) break;
		const {i, j, overlap} = choice;
		const source = groups[i], target = groups[j];
		merged.push({floors: [...source.floors], into: [...target.floors], area: source.area, overlap});
		target.floors.push(...source.floors);
		target.area += source.area;
		target.height += source.height;
		groups.splice(i, 1);
	}
	const displayOf = new Map(groups.flatMap((group, i) => group.floors.map(floor => [floor, i])));
	const labels = Int32Array.from(partition.labels, floor => displayOf.get(floor));
	let mergedOcclusionArea = 0;
	for (const [key, area] of occlusion.relations) {
		const [a, b] = key.split(":").map(Number);
		if (labels[a] > labels[b]) throw new Error("Display floor coalescing reversed occlusion order");
		if (labels[a] === labels[b]) mergedOcclusionArea += area;
	}
	const summary = summarizePartition(graph, labels);
	return {...partition, ...summary, labels, stats: {...partition.stats,
		logicalFloors: partition.levels.length, regions: summary.regions.length,
		minimumDisplayArea: minimumArea, displayAreas: groups.map(group => group.area),
		mergedFloorBoundaries: merged.length, mergedOcclusionArea, mergedFloorGroups: merged,
	}};
}
