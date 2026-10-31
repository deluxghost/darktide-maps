import { Plane, Vector3 } from "three";
import { clip, faceArea, trianglePoints } from "./geometry.mjs";
import { BUILD_CONFIG } from "../config.mjs";

function projectedArea(ring) {
	let area = 0;
	for (let i = 0; i + 1 < ring.length; i++)
		area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
	return Math.abs(area) / 2;
}

// Every input is a convex projection of a plane-clipped triangle.
function clipByPlane(points, plane) {
	const result = [];
	for (let j = 0; j < points.length; j++) {
		const p = points[j],
			q = points[(j + 1) % points.length];
		const dp = plane.distanceToPoint(p),
			dq = plane.distanceToPoint(q);
		if (dp >= 0) result.push(p);
		if (dp * dq < 0) result.push(p.clone().lerp(q, dp / (dp - dq)));
	}
	return result;
}

function convexIntersection(left, right) {
	let points = left.slice(0, -1).map((p) => new Vector3(p[0], p[1], 0));
	let winding = 0;
	for (let i = 0; i + 1 < right.length; i++)
		winding += right[i][0] * right[i + 1][1] - right[i + 1][0] * right[i][1];
	const sign = Math.sign(winding);
	for (let i = 0; i + 1 < right.length && points.length >= 3; i++) {
		const a = right[i],
			b = right[i + 1];
		const normal = new Vector3(-(b[1] - a[1]) * sign, (b[0] - a[0]) * sign, 0);
		if (normal.lengthSq() === 0) continue;
		const plane = new Plane(normal, -normal.x * a[0] - normal.y * a[1]);
		points = clipByPlane(points, plane);
	}
	return points;
}

export function findOcclusion(graph) {
	const start = performance.now(),
		polygons = [],
		grid = new Map(),
		relations = new Map();
	const { broadPhaseCellSize: cellSize, occlusionClearance: clearance } =
		BUILD_CONFIG.floors;
	let candidates = 0,
		intersections = 0;
	for (let i = 0; i < graph.pieces.length; i++) {
		const piece = graph.pieces[i],
			p = trianglePoints(graph.mesh, piece.triangle);
		const face = clip(
			clip(p, graph.base + piece.band * graph.step, true),
			graph.base + (piece.band + 1) * graph.step,
			false,
		);
		const ring = face.map((v) => [v.x, v.y]);
		ring.push(ring[0]);
		const bounds = [
			Math.min(...face.map((v) => v.x)),
			Math.min(...face.map((v) => v.y)),
			Math.max(...face.map((v) => v.x)),
			Math.max(...face.map((v) => v.y)),
		];
		const plane = new Plane().setFromCoplanarPoints(...p);
		const height = [
			-plane.normal.x / plane.normal.z,
			-plane.normal.y / plane.normal.z,
			-plane.constant / plane.normal.z,
		];
		const polygon = {
			ring,
			bounds,
			height,
			band: piece.band,
			node: graph.nodeOfPiece[i],
		};
		polygons.push(polygon);
		if (projectedArea(ring) < 1e-8) continue;
		const seen = new Set();
		for (
			let x = Math.floor(bounds[0] / cellSize);
			x <= Math.floor(bounds[2] / cellSize);
			x++
		) {
			for (
				let y = Math.floor(bounds[1] / cellSize);
				y <= Math.floor(bounds[3] / cellSize);
				y++
			) {
				const key = x + ":" + y,
					others = grid.get(key) || [];
				for (const j of others) {
					if (seen.has(j)) continue;
					seen.add(j);
					const other = polygons[j];
					if ((Math.abs(piece.band - other.band) + 1) * graph.step < clearance)
						continue;
					if (
						bounds[0] >= other.bounds[2] ||
						bounds[2] <= other.bounds[0] ||
						bounds[1] >= other.bounds[3] ||
						bounds[3] <= other.bounds[1]
					)
						continue;
					candidates++;
					const points = convexIntersection(ring, other.ring),
						sign = Math.sign(piece.band - other.band);
					const difference = height.map((h, k) => (h - other.height[k]) * sign);
					const gap = new Plane(
						new Vector3(difference[0], difference[1], 0),
						difference[2] - clearance,
					);
					const overlap = clipByPlane(points, gap),
						area = faceArea(overlap);
					if (area < 1e-7) continue;
					intersections++;
					const lower = piece.band < other.band ? polygon.node : other.node;
					const upper = piece.band < other.band ? other.node : polygon.node;
					const relationKey = lower + ":" + upper;
					relations.set(relationKey, (relations.get(relationKey) || 0) + area);
				}
				others.push(i);
				grid.set(key, others);
			}
		}
	}
	return {
		relations,
		stats: {
			clearance,
			pairCandidates: candidates,
			polygonIntersections: intersections,
			relations: relations.size,
			overlapMs: performance.now() - start,
		},
	};
}
