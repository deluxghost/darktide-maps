export function summarizePartition(graph, labels) {
	const regions = [], levels = [], visited = new Uint8Array(labels.length);
	for (let n = 0; n < labels.length; n++) {
		if (visited[n]) continue;
		const region = {id: n, nodes: [n], floor: labels[n], area: 0, minZ: Infinity, maxZ: -Infinity};
		visited[n] = 1;
		for (let i = 0; i < region.nodes.length; i++) {
			const node = graph.nodes[region.nodes[i]];
			region.area += node.area;
			region.minZ = Math.min(region.minZ, graph.base + node.band * graph.step);
			region.maxZ = Math.max(region.maxZ, graph.base + (node.band + 1) * graph.step);
			for (const other of node.edges) {
				if (visited[other] || labels[other] !== region.floor) continue;
				visited[other] = 1;
				region.nodes.push(other);
			}
		}
		regions.push(region);
		while (levels.length <= region.floor) levels.push({minZ: Infinity, maxZ: -Infinity});
		const level = levels[region.floor];
		level.minZ = Math.min(level.minZ, region.minZ);
		level.maxZ = Math.max(level.maxZ, region.maxZ);
	}
	return {regions, levels};
}
