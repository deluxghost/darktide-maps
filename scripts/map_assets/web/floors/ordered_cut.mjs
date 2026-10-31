import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DisjointSet } from "./geometry.mjs";
import { summarizePartition } from "./regions.mjs";

export function verifyFloorDependencies() {
	const result = spawnSync(
		process.env.PYTHON || "python",
		["-c", "import numpy; from scipy.sparse.csgraph import maximum_flow"],
		{ encoding: "utf8" },
	);
	if (result.error || result.status !== 0) {
		throw new Error(
			`Layer construction requires Python with scripts/requirements.txt installed. Set PYTHON to that interpreter.\n${result.error?.message ?? result.stderr}`,
		);
	}
}

function createOrderingBaseline(graph, occlusion) {
	const count = graph.nodes.length,
		ds = new DisjointSet(count);
	const above = Array.from({ length: count }, () => new Set()),
		below = Array.from({ length: count }, () => new Set());
	for (const key of occlusion.relations.keys()) {
		const [a, b] = key.split(":").map(Number);
		above[a].add(b);
		below[b].add(a);
	}
	function reachable(a, b) {
		const visited = new Set([a]),
			queue = [a];
		for (let i = 0; i < queue.length; i++)
			for (const next of above[queue[i]]) {
				if (next === b) return true;
				if (!visited.has(next)) {
					visited.add(next);
					queue.push(next);
				}
			}
		return false;
	}
	// Preserve expensive connections first; all accepted regions remain connected and acyclic.
	const edges = [...graph.edgeCosts]
		.map(([key, cost]) => ({ nodes: key.split(":").map(Number), cost }))
		.sort((a, b) => b.cost - a.cost);
	let rejectedMerges = 0;
	for (const edge of edges) {
		const a = ds.find(edge.nodes[0]),
			b = ds.find(edge.nodes[1]);
		if (a === b) continue;
		if (reachable(a, b) || reachable(b, a)) {
			rejectedMerges++;
			continue;
		}
		ds.union(a, b);
		const root = ds.find(a),
			old = root === a ? b : a;
		for (const n of above[old]) {
			below[n].delete(old);
			below[n].add(root);
			above[root].add(n);
		}
		for (const n of below[old]) {
			above[n].delete(old);
			above[n].add(root);
			below[root].add(n);
		}
		above[old].clear();
		below[old].clear();
	}
	const regions = new Map();
	for (let i = 0; i < count; i++) {
		const r = ds.find(i);
		if (!regions.has(r))
			regions.set(r, {
				id: r,
				area: 0,
				minZ: Infinity,
				maxZ: -Infinity,
				nodes: [],
				floor: 0,
			});
		const region = regions.get(r),
			node = graph.nodes[i];
		region.area += node.area;
		region.minZ = Math.min(region.minZ, graph.base + node.band * graph.step);
		region.maxZ = Math.max(
			region.maxZ,
			graph.base + (node.band + 1) * graph.step,
		);
		region.nodes.push(i);
	}
	const degree = Int32Array.from(below, (x) => x.size),
		queue = [...regions.keys()].filter((r) => degree[r] === 0);
	for (let i = 0; i < queue.length; i++)
		for (const other of above[queue[i]]) {
			regions.get(other).floor = Math.max(
				regions.get(other).floor,
				regions.get(queue[i]).floor + 1,
			);
			if (--degree[other] === 0) queue.push(other);
		}
	if (queue.length !== regions.size)
		throw new Error("Occlusion ordering contains a cycle");
	const labels = Int32Array.from(
			{ length: count },
			(_, i) => regions.get(ds.find(i)).floor,
		),
		levels = [];
	for (const region of regions.values()) {
		while (levels.length <= region.floor)
			levels.push({ minZ: Infinity, maxZ: -Infinity });
		const level = levels[region.floor];
		level.minZ = Math.min(level.minZ, region.minZ);
		level.maxZ = Math.max(level.maxZ, region.maxZ);
	}
	return {
		labels,
		levels,
		regions: [...regions.values()],
		stats: { ...occlusion.stats, regions: regions.size, rejectedMerges },
	};
}

export function partitionOrderedCut(graph, occlusion) {
	const started = performance.now();
	// The greedy baseline bounds the label count; it is not an alternate solver.
	const baseline = createOrderingBaseline(graph, occlusion);
	const structural = solveOrderedCut(graph, occlusion, baseline, [], null);
	if (structural.levels.length === 1 || !graph.affinities?.length) return structural;
	const result = solveOrderedCut(graph, occlusion, baseline, graph.affinities, structural.labels);
	result.stats.structuralSolverMs = structural.stats.solverMs;
	result.stats.attachmentSolverMs = result.stats.solverMs;
	result.stats.optimizationMs = performance.now() - started;
	return result;
}

function solveOrderedCut(graph, occlusion, baseline, affinities, fixedLabels) {
	const started = performance.now();
	const count = graph.nodes.length,
		ordering = Array.from({ length: count }, () => []);
	const physicalCosts = [...graph.edgeCosts].map(([key, cost]) => {
		const nodes = key
			.split(":")
			.map(Number)
			.sort((a, b) => graph.nodes[a].band - graph.nodes[b].band);
		ordering[nodes[0]].push([nodes[1], 0]);
		return { nodes, cost };
	});
	const costs = [...physicalCosts, ...affinities];
	for (const key of occlusion.relations.keys()) {
		const [a, b] = key.split(":").map(Number);
		ordering[a].push([b, 1]);
	}
	const minimumLabels = new Int32Array(count);
	const byHeight = Array.from({ length: count }, (_, n) => n).sort(
		(a, b) => graph.nodes[a].band - graph.nodes[b].band,
	);
	for (const n of byHeight)
		for (const [other, step] of ordering[n])
			minimumLabels[other] = Math.max(
				minimumLabels[other],
				minimumLabels[n] + step,
			);
	const minimumFloors = Math.max(...minimumLabels) + 1;
	const span = Math.max(baseline.levels.length, minimumFloors) - 1;
	// Leave a complete stack's span on both sides of the fixed reference, then rebase.
	const referenceOffset = fixedLabels ? span : 0;
	const thresholds = fixedLabels ? span * 3 : span;
	if (thresholds === 0) return baseline;
	const source = count * thresholds,
		sink = source + 1,
		edges = [],
		hardEdges = new Map();
	const constrain = (a, b) => hardEdges.set(a + ":" + b, [a, b]);
	const vertex = (node, threshold) => node * thresholds + threshold - 1;
	const scale = 1e7 / (costs.reduce((sum, e) => sum + e.cost, 0) * thresholds);
	const weights = costs.map((e) => Math.max(1, Math.round(e.cost * scale)));
	const hard = 2 * weights.reduce((sum, w) => sum + w, 0) * thresholds + 1;
	for (let n = 0; n < count; n++) {
		for (let k = 2; k <= thresholds; k++)
			constrain(vertex(n, k), vertex(n, k - 1));
		if (fixedLabels && graph.primaryNodes.has(n)) {
			const floor = fixedLabels[n] + referenceOffset;
			if (floor > 0) constrain(source, vertex(n, floor));
			if (floor < thresholds) constrain(vertex(n, floor + 1), sink);
		}
	}
	for (const key of occlusion.relations.keys()) {
		const [lower, upper] = key.split(":").map(Number);
		constrain(source, vertex(upper, 1));
		constrain(vertex(lower, thresholds), sink);
		for (let k = 1; k < thresholds; k++)
			constrain(vertex(lower, k), vertex(upper, k + 1));
	}
	for (let i = 0; i < costs.length; i++) {
		const [a, b] = costs[i].nodes;
		if (i < physicalCosts.length)
			for (let k = 1; k <= thresholds; k++) constrain(vertex(a, k), vertex(b, k));
		for (let k = 1; k <= thresholds; k++)
			edges.push(
				[vertex(a, k), vertex(b, k), weights[i]],
				[vertex(b, k), vertex(a, k), weights[i]],
			);
	}
	for (const edge of hardEdges.values()) edges.push([...edge, hard]);
	const result = spawnSync(
		process.env.PYTHON || "python",
		[fileURLToPath(new URL("./ordered_cut.py", import.meta.url))],
		{
			input: JSON.stringify({ edges, size: sink + 1, source, sink }),
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr);
	const solved = JSON.parse(result.stdout),
		reachable = new Set(solved.reachable);
	if (solved.flow >= hard || reachable.has(sink))
		throw new Error("Ordered cut violated a hard constraint");
	const labels = Int32Array.from({ length: count }, (_, n) => {
		let label = 0;
		for (let k = 1; k <= thresholds; k++)
			if (reachable.has(vertex(n, k))) label++;
		return label;
	});
	if (fixedLabels) for (const n of graph.primaryNodes)
		if (labels[n] !== fixedLabels[n] + referenceOffset) throw new Error("Attachment assignment changed a primary surface floor");
	for (const key of occlusion.relations.keys()) {
		const [a, b] = key.split(":").map(Number);
		if (labels[a] >= labels[b]) throw new Error("Occlusion ordering violated");
	}
	for (const {
		nodes: [a, b],
	} of physicalCosts)
		if (labels[a] > labels[b])
			throw new Error("Floor index decreases along an ascending surface");
	const firstFloor = Math.min(...labels);
	for (let n = 0; n < count; n++) labels[n] -= firstFloor;
	const {regions, levels} = summarizePartition(graph, labels);
	const energy = (labels) =>
		costs.reduce(
			(sum, e) =>
				sum + e.cost * Math.abs(labels[e.nodes[0]] - labels[e.nodes[1]]),
			0,
		);
	return {
		labels,
		levels,
		regions,
		stats: {
			...occlusion.stats,
			regions: regions.length,
			algorithm: "ordered-cut-v4",
			minimumFloors,
			solverVertices: sink + 1,
			solverEdges: edges.length,
			solverMs: solved.solverMs,
			optimizationMs: performance.now() - started,
			baselineEnergy: energy(baseline.labels),
			cutEnergy: energy(labels),
			baselineFloors: baseline.levels.length,
			baselineRegions: baseline.regions.length,
			referenceFloorOffset: referenceOffset - firstFloor,
		},
	};
}
