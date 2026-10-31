import { Triangle, Vector3 } from "three";
import { clip, trianglePoints } from "./geometry.mjs";

export function compilePartition(graph, partition) {
	const positions = [],
		labels = [],
		indices = [],
		index = new Map();
	let area = 0,
		maxTriangleAreaError = 0,
		floatArea = 0,
		maxFloatTriangleAreaError = 0,
		triangleArea = 0,
		floatTriangleArea = 0;
	function emit(face, floor) {
		for (let k = 1; k + 1 < face.length; k++) {
			const p = [face[0], face[k], face[k + 1]],
				a = new Triangle(...p).getArea();
			if (a === 0) continue;
			triangleArea += a;
			floatTriangleArea += new Triangle(
				...p.map((v) => new Vector3(...v.toArray().map(Math.fround))),
			).getArea();
			for (const v of p) {
				const xyz = v.toArray().map(Math.fround),
					key = xyz.join(",") + ":" + floor;
				if (!index.has(key)) {
					index.set(key, labels.length);
					positions.push(...xyz);
					labels.push(floor);
				}
				indices.push(index.get(key));
			}
		}
	}
	for (let t = 0; t < graph.byTriangle.length; t++) {
		const points = trianglePoints(graph.mesh, t);
		// Keep tiny faces measurable without subtracting whole-map area totals.
		triangleArea = 0;
		floatTriangleArea = 0;
		let first, last, floor;
		function flush() {
			if (first === undefined) return;
			emit(
				clip(
					clip(points, graph.base + first * graph.step, true),
					graph.base + (last + 1) * graph.step,
					false,
				),
				floor,
			);
		}
		for (const [band, piece] of graph.byTriangle[t]) {
			const label = partition.labels[graph.nodeOfPiece[piece]];
			if (floor !== label) {
				flush();
				first = band;
				floor = label;
			}
			last = band;
		}
		flush();
		const originalArea = new Triangle(...points).getArea();
		const error = Math.abs(triangleArea - originalArea);
		const floatError = Math.abs(floatTriangleArea - originalArea);
		if (
			error > 1e-7 ||
			floatError > 1e-4 + originalArea * 5e-4 ||
			(originalArea > 0 && triangleArea === 0)
		) {
			throw new Error(
				`Floor partition lost triangle coverage at source triangle ${t}: ${error}, float32 ${floatError}.`,
			);
		}
		maxTriangleAreaError = Math.max(maxTriangleAreaError, error);
		maxFloatTriangleAreaError = Math.max(maxFloatTriangleAreaError, floatError);
		area += triangleArea;
		floatArea += floatTriangleArea;
	}
	return {
		positions,
		labels,
		indices,
		stats: {
			...graph.stats,
			floors: partition.levels.length,
			outputTriangles: indices.length / 3,
			outputVertices: labels.length,
			areaError: Math.abs(area - graph.stats.originalArea),
			maxTriangleAreaError,
			floatAreaError: Math.abs(floatArea - graph.stats.originalArea),
			maxFloatTriangleAreaError,
		},
	};
}
