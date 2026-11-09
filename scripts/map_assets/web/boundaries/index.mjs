import {BUILD_CONFIG} from "../config.mjs";
import {createPaths, isCollapsedPath} from "./paths.mjs";

// Probe beyond edges to find exposed boundaries. Geometric coverage, rather than shared vertex IDs,
// suppresses internal edges at T-junctions and seams.
const {coordinatePrecision: PRECISION, probeOffset: PROBE_OFFSET, probeSpacing: PROBE_SPACING,
	surfaceHeight: SURFACE_HEIGHT} = BUILD_CONFIG.boundaries;
const CELL = 2;              // m; plan grid of the triangle index
const MIN_PLAN_AREA = 1e-9;  // m2; triangles with no plan extent bound nothing

function planArea(a, b, c) {
	return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function surfaceIndex(triangles) {
	const cells = new Map();
	triangles.forEach((triangle, id) => {
		const xs = triangle.map((point) => point[0]), ys = triangle.map((point) => point[1]);
		for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++) {
			for (let j = Math.floor(Math.min(...ys) / CELL); j <= Math.floor(Math.max(...ys) / CELL); j++) {
				const key = `${i},${j}`;
				if (!cells.has(key)) cells.set(key, []);
				cells.get(key).push(id);
			}
		}
	});
	return (x, y, z) => (cells.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []).some((id) => {
		const [a, b, c] = triangles[id];
		const area = planArea(a, b, c);
		const u = planArea([x, y], b, c) / area, v = planArea(a, [x, y], c) / area, w = 1 - u - v;
		return u >= 0 && v >= 0 && w >= 0 && Math.abs(u * a[2] + v * b[2] + w * c[2] - z) <= SURFACE_HEIGHT;
	});
}

export function createBoundaryPaths(navmesh) {
	const triangles = navmesh.triangles
		.map((triangle) => triangle.slice(0, 3).map((index) => navmesh.vertices[index - 1]))
		.filter(([a, b, c]) => Math.abs(planArea(a, b, c)) > MIN_PLAN_AREA);
	const covered = surfaceIndex(triangles);
	const vertexIds = new Map(), vertices = [], edges = [];
	const vertex = (point) => {
		const key = point.map((value) => value.toFixed(PRECISION)).join(",");
		if (!vertexIds.has(key)) {
			vertexIds.set(key, vertices.length);
			vertices.push(point);
		}
		return vertexIds.get(key);
	};
	const at = (a, b, t) => a.map((value, axis) => value + (b[axis] - value) * t);
	for (const triangle of triangles) {
		const turn = Math.sign(planArea(...triangle));
		for (let k = 0; k < 3; k++) {
			const a = triangle[k], b = triangle[(k + 1) % 3];
			const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
			if (length === 0) continue;
			// outward normal in plan: to the right of a -> b for a counter-clockwise triangle
			const nx = turn * (b[1] - a[1]) / length, ny = -turn * (b[0] - a[0]) / length;
			const steps = Math.max(1, Math.ceil(length / PROBE_SPACING));
			let start = null;
			for (let step = 0; step <= steps; step++) {
				const open = step < steps && (() => {
					const point = at(a, b, (step + 0.5) / steps);
					return !covered(point[0] + nx * PROBE_OFFSET, point[1] + ny * PROBE_OFFSET, point[2]);
				})();
				if (open && start === null) start = step;
				if (!open && start !== null) {
					const from = vertex(at(a, b, start / steps)), to = vertex(at(a, b, step / steps));
					if (from !== to) edges.push({start: from, end: to});
					start = null;
				}
			}
		}
	}
	return createPaths(edges)
		.map((path) => path.map((id) => vertices[id]))
		.filter((path) => !isCollapsedPath(path));
}
