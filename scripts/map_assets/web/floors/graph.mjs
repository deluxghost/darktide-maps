import { Vector3, Triangle } from "three";
import { createTriangleAdjacency } from "../navmesh_adjacency.mjs";
import {
	clip,
	faceArea,
	trianglePoints,
	sharedInterval,
	DisjointSet,
} from "./geometry.mjs";
import { BUILD_CONFIG } from "../config.mjs";
const BAND_STEP = BUILD_CONFIG.floors.analysisBandStep;

// Height bands are analysis nodes, not a final per-cell ownership representation.
export function buildBandGraph(mesh, step = BAND_STEP) {
	const started = performance.now(),
		triangles = mesh.indices.length / 3;
	const vertices = Array.from({ length: mesh.positions.length / 3 }, (_, i) =>
		Array.from(mesh.positions.slice(i * 3, i * 3 + 3)),
	);
	const indexed = Array.from({ length: triangles }, (_, t) =>
		Array.from(mesh.indices.slice(t * 3, t * 3 + 3), (i) => i + 1),
	);
	const adjacency = createTriangleAdjacency({ vertices, triangles: indexed });
	const adjacencyMs = performance.now() - started;
	let minZ = Infinity;
	for (let i = 2; i < mesh.positions.length; i += 3)
		minZ = Math.min(minZ, mesh.positions[i]);
	const base = Math.floor(minZ / step) * step - 0.000123;
	const pieces = [],
		byTriangle = [],
		points = [];
	let originalArea = 0;
	for (let t = 0; t < triangles; t++) {
		const p = trianglePoints(mesh, t);
		points.push(p);
		originalArea += new Triangle(...p).getArea();
		const first = Math.floor((Math.min(...p.map((v) => v.z)) - base) / step);
		const last = Math.floor((Math.max(...p.map((v) => v.z)) - base) / step);
		const entries = new Map();
		byTriangle.push(entries);
		for (let band = first; band <= last; band++) {
			const face = clip(
				clip(p, base + band * step, true),
				base + (band + 1) * step,
				false,
			);
			const area = faceArea(face);
			if (area === 0) continue;
			entries.set(band, pieces.length);
			pieces.push({ triangle: t, band, area });
		}
	}
	const ds = new DisjointSet(pieces.length);
	let rejectedAdjacency = 0,
		connectedEdges = 0;
	for (let t = 0; t < triangles; t++)
		for (const other of adjacency[t]) {
			if (other <= t) continue;
			const interval = sharedInterval(points[t], points[other]);
			if (!interval) {
				rejectedAdjacency++;
				continue;
			}
			connectedEdges++;
			const first = Math.floor((interval[0] - base) / step),
				last = Math.floor((interval[1] - base) / step);
			for (let band = first; band <= last; band++) {
				const a = byTriangle[t].get(band),
					b = byTriangle[other].get(band);
				if (a !== undefined && b !== undefined) ds.union(a, b);
			}
		}
	const roots = new Map(),
		nodes = [],
		nodeOfPiece = new Int32Array(pieces.length),
		edgeCosts = new Map();
	for (let i = 0; i < pieces.length; i++) {
		const r = ds.find(i),
			p = pieces[i];
		if (!roots.has(r)) {
			roots.set(r, nodes.length);
			nodes.push({ band: p.band, area: 0, edges: new Set(), pieces: [] });
		}
		const id = roots.get(r);
		nodeOfPiece[i] = id;
		nodes[id].area += p.area;
		nodes[id].pieces.push(i);
	}
	for (let t = 0; t < byTriangle.length; t++) {
		const entries = byTriangle[t];
		let previous;
		for (const p of entries.values()) {
			const n = nodeOfPiece[p];
			if (previous !== undefined && previous !== n) {
				nodes[n].edges.add(previous);
				nodes[previous].edges.add(n);
				const z = base + pieces[p].band * step,
					intersections = [];
				for (let k = 0; k < 3; k++) {
					const a = points[t][k],
						b = points[t][(k + 1) % 3];
					if ((a.z - z) * (b.z - z) < 0)
						intersections.push(a.clone().lerp(b, (z - a.z) / (b.z - a.z)));
				}
				if (intersections.length === 2) {
					const key = Math.min(n, previous) + ":" + Math.max(n, previous);
					const width = intersections[0].distanceTo(intersections[1]);
					const normal = new Triangle(...points[t]).getNormal(new Vector3());
					const verticalGradient = Math.hypot(normal.x, normal.y);
					if (verticalGradient === 0)
						throw new Error("Horizontal triangle crossed a height band");
					// Coarea density: flat surfaces cost more than steep transitions of the same width.
					edgeCosts.set(
						key,
						(edgeCosts.get(key) || 0) + width / verticalGradient,
					);
				}
			}
			previous = n;
		}
	}
	const area = pieces.reduce((s, p) => s + p.area, 0);
	return {
		mesh,
		nodes,
		pieces,
		byTriangle,
		nodeOfPiece,
		edgeCosts,
		base,
		step,
		stats: {
			triangles,
			pieces: pieces.length,
			nodes: nodes.length,
			connectedEdges,
			rejectedAdjacency,
			originalArea,
			analysisAreaError: Math.abs(originalArea - area),
			adjacencyMs,
			graphMs: performance.now() - started,
		},
	};
}
