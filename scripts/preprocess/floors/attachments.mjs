import {BufferAttribute, BufferGeometry, Vector3} from "three";
import {MeshBVH} from "three-mesh-bvh";
import {PREPROCESS_CONFIG} from "../config.mjs";
import {clip, trianglePoints} from "./geometry.mjs";

const CONFIG = PREPROCESS_CONFIG.floors;
const MAXIMUM_MAP_SHARE = 0.05;

export function minimumDisplayArea(graph) {
	return Math.min(graph.stats.originalArea * MAXIMUM_MAP_SHARE, Math.max(CONFIG.minimumDisplayFloorArea, Math.min(
		CONFIG.maximumDisplayFloorArea,
		graph.stats.originalArea * CONFIG.minimumDisplayFloorShare,
	)));
}

function connectedComponents(graph) {
	const visited = new Uint8Array(graph.nodes.length);
	const components = [];
	for (let n = 0; n < graph.nodes.length; n++) {
		if (visited[n]) continue;
		const component = {nodes: [n], area: 0};
		visited[n] = 1;
		for (let i = 0; i < component.nodes.length; i++) {
			const node = graph.nodes[component.nodes[i]];
			component.area += node.area;
			for (const other of node.edges) {
				if (visited[other]) continue;
				visited[other] = 1;
				component.nodes.push(other);
			}
		}
		components.push(component);
	}
	return components;
}

function nodeSamples(graph, node) {
	const extremes = Array(6).fill(null);
	for (const p of node.pieces) {
		const points = trianglePoints(graph.mesh, graph.pieces[p].triangle);
		const face = clip(clip(points, graph.base + node.band * graph.step, true),
			graph.base + (node.band + 1) * graph.step, false);
		for (const point of face) {
			for (let axis = 0; axis < 3; axis++) {
				const value = point.getComponent(axis);
				if (!extremes[axis * 2] || value < extremes[axis * 2].getComponent(axis)) extremes[axis * 2] = point;
				if (!extremes[axis * 2 + 1] || value > extremes[axis * 2 + 1].getComponent(axis)) extremes[axis * 2 + 1] = point;
			}
		}
	}
	return [...new Set(extremes)];
}

export function connectAttachments(graph) {
	const started = performance.now();
	const components = connectedComponents(graph);
	const minimumArea = minimumDisplayArea(graph);
	const small = components.filter(component => component.area < minimumArea);
	const primaryNodes = new Set(components.filter(component => component.area >= minimumArea).flatMap(component => component.nodes));
	graph.primaryNodes = primaryNodes;
	const triangles = [];
	for (let t = 0; t < graph.byTriangle.length; t++) {
		if ([...graph.byTriangle[t].values()].some(p => primaryNodes.has(graph.nodeOfPiece[p]))) triangles.push(t);
	}
	graph.affinities = [];
	if (!triangles.length) return {attachmentComponents: 0, attachmentNodes: 0, unattachedComponents: small.length, attachmentMs: performance.now() - started};
	const positions = Float32Array.from(graph.mesh.positions, (value, i) => i % 3 === 2 ? value * CONFIG.attachmentVerticalScale : value);
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new BufferAttribute(positions, 3));
	geometry.setIndex(new BufferAttribute(Uint32Array.from(triangles.flatMap(t => Array.from(graph.mesh.indices.slice(t * 3, t * 3 + 3)))), 1));
	const bvh = new MeshBVH(geometry, {indirect: true});
	const query = new Vector3();
	let attached = 0;
	for (const component of small) {
		let matched = false;
		for (const n of component.nodes) {
			const node = graph.nodes[n];
			let best = null;
			for (const sample of nodeSamples(graph, node)) {
				query.copy(sample);
				query.z *= CONFIG.attachmentVerticalScale;
				const hit = bvh.closestPointToPoint(query, {}, 0, CONFIG.attachmentDistance);
				if (!hit || (best && hit.distance >= best.distance)) continue;
				const z = hit.point.z / CONFIG.attachmentVerticalScale;
				const entries = graph.byTriangle[triangles[hit.faceIndex]];
				const bands = [...entries.keys()];
				// Boundary hits belong to the triangle's nonempty band interval.
				const band = Math.max(bands[0], Math.min(bands.at(-1), Math.floor((z - graph.base) / graph.step)));
				best = {distance: hit.distance, node: graph.nodeOfPiece[entries.get(band)]};
			}
			if (!best) continue;
			matched = true;
			graph.affinities.push({nodes: [n, best.node], cost: node.area / Math.sqrt(component.area)});
		}
		if (matched) attached++;
	}
	geometry.dispose();
	return {attachmentComponents: attached, attachmentNodes: graph.affinities.length, unattachedComponents: small.length - attached, attachmentMs: performance.now() - started};
}
