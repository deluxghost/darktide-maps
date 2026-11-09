import {BufferAttribute, BufferGeometry, Vector3} from "three";
import {MeshBVH} from "three-mesh-bvh";
import {BUILD_CONFIG} from "../config.mjs";
import {clip, trianglePoints, DisjointSet} from "./geometry.mjs";

const CONFIG = BUILD_CONFIG.floors;
const MINIMUM_AFFINITY_DISTANCE = 1;
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

function indexComponents(graph, components) {
	const componentOfNode = new Int32Array(graph.nodes.length);
	for (const [id, component] of components.entries()) {
		component.id = id;
		component.triangles = [];
		component.samples = component.nodes.flatMap(node => nodeSamples(graph, graph.nodes[node]).map(point => ({point, node})));
		for (const node of component.nodes) componentOfNode[node] = id;
	}
	for (let triangle = 0; triangle < graph.byTriangle.length; triangle++) {
		const piece = graph.byTriangle[triangle].values().next().value;
		if (piece === undefined) continue;   // zero-area triangles hold no surface and belong to no floor
		components[componentOfNode[graph.nodeOfPiece[piece]]].triangles.push(triangle);
	}
	const positions = new BufferAttribute(Float32Array.from(graph.mesh.positions,
		(value, i) => i % 3 === 2 ? value * CONFIG.attachmentVerticalScale : value), 3);
	for (const component of components) {
		component.geometry = new BufferGeometry();
		component.geometry.setAttribute("position", positions);
		component.geometry.setIndex(new BufferAttribute(Uint32Array.from(component.triangles.flatMap(
			t => Array.from(graph.mesh.indices.slice(t * 3, t * 3 + 3)))), 1));
		component.bvh = new MeshBVH(component.geometry, {indirect: true});
	}
}

function closestBridge(graph, a, b) {
	const [source, target] = a.samples.length < b.samples.length ? [a, b] : [b, a];
	const query = new Vector3();
	let best = null;
	for (const {point, node} of source.samples) {
		query.copy(point);
		query.z *= CONFIG.attachmentVerticalScale;
		const hit = target.bvh.closestPointToPoint(query, {}, 0, best?.distance ?? Infinity);
		if (!hit || (best && hit.distance >= best.distance)) continue;
		const entries = graph.byTriangle[target.triangles[hit.faceIndex]];
		const bands = [...entries.keys()];
		const z = hit.point.z / CONFIG.attachmentVerticalScale;
		const band = Math.max(bands[0], Math.min(bands.at(-1), Math.floor((z - graph.base) / graph.step)));
		best = {distance: hit.distance, nodes: [node, graph.nodeOfPiece[entries.get(band)]]};
	}
	if (!best) throw new Error("Disconnected surface group has no spatial reference");
	return {...best, components: [a.id, b.id],
		cost: Math.sqrt(Math.min(a.area, b.area)) / Math.max(MINIMUM_AFFINITY_DISTANCE, best.distance)};
}

export function connectAttachments(graph, occlusion) {
	const started = performance.now();
	const components = connectedComponents(graph);
	const constrained = new Set([...occlusion.relations.keys()].flatMap(key => key.split(":").map(Number)));
	const structural = components.filter(component => component.nodes.some(node => constrained.has(node)));
	graph.affinities = [];
	if (!structural.length) return {singleLayerComponents: components.length, attachmentMs: performance.now() - started};
	// Only continuous geometry is fixed. Spatial bridges carry local context across Nav gaps.
	const primary = structural.reduce((largest, component) => component.area > largest.area ? component : largest);
	graph.primaryNodes = new Set(primary.nodes);
	indexComponents(graph, components);
	const bridges = [];
	for (let a = 0; a < components.length; a++)
		for (let b = a + 1; b < components.length; b++)
			bridges.push(closestBridge(graph, components[a], components[b]));
	bridges.sort((a, b) => a.distance - b.distance);
	const connected = new DisjointSet(components.length);
	for (const bridge of bridges) {
		const [a, b] = bridge.components;
		if (connected.find(a) === connected.find(b)) continue;
		connected.union(a, b);
		graph.affinities.push({nodes: bridge.nodes, cost: bridge.cost});
	}
	for (const component of components) component.geometry.dispose();
	if (graph.affinities.length !== components.length - 1) throw new Error("Spatial surface graph is disconnected");
	return {surfaceComponents: components.length, referenceArea: primary.area,
		spatialBridges: graph.affinities.length, attachmentMs: performance.now() - started};
}
