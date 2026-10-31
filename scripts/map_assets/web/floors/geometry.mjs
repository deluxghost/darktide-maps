import { Plane, Vector3, Line3, Triangle } from "three";
const EDGE_TOLERANCE = 1e-4;

export function clip(points, z, positive) {
	const plane = new Plane(new Vector3(0, 0, 1), -z);
	const result = [];
	for (let i = 0; i < points.length; i++) {
		const a = points[i],
			b = points[(i + 1) % points.length];
		const da = a.z - z,
			db = b.z - z;
		if (positive ? da >= 0 : da <= 0) result.push(a);
		if (da * db < 0)
			result.push(plane.intersectLine(new Line3(a, b), new Vector3()));
	}
	return result;
}

export function faceArea(points) {
	let area = 0;
	for (let i = 1; i + 1 < points.length; i++)
		area += new Triangle(points[0], points[i], points[i + 1]).getArea();
	return area;
}

export function trianglePoints(mesh, t) {
	return [0, 1, 2].map((k) =>
		new Vector3().fromArray(mesh.positions, mesh.indices[t * 3 + k] * 3),
	);
}

function edgeOverlap(a, b, c, d) {
	const direction = b.clone().sub(a),
		length2 = direction.lengthSq();
	if (length2 < EDGE_TOLERANCE ** 2) return null;
	const tc = c.clone().sub(a).dot(direction) / length2;
	const td = d.clone().sub(a).dot(direction) / length2;
	if (
		a.clone().addScaledVector(direction, tc).distanceTo(c) > EDGE_TOLERANCE ||
		a.clone().addScaledVector(direction, td).distanceTo(d) > EDGE_TOLERANCE
	)
		return null;
	const start = Math.max(0, Math.min(tc, td)),
		end = Math.min(1, Math.max(tc, td));
	if ((end - start) * Math.sqrt(length2) <= EDGE_TOLERANCE) return null;
	const z1 = a.z + direction.z * start,
		z2 = a.z + direction.z * end;
	return [Math.min(z1, z2), Math.max(z1, z2)];
}

export function sharedInterval(left, right) {
	let lo = Infinity,
		hi = -Infinity;
	for (let a = 0; a < 3; a++)
		for (let b = 0; b < 3; b++) {
			const overlap = edgeOverlap(
				left[a],
				left[(a + 1) % 3],
				right[b],
				right[(b + 1) % 3],
			);
			if (overlap) {
				lo = Math.min(lo, overlap[0]);
				hi = Math.max(hi, overlap[1]);
			}
		}
	return hi >= lo ? [lo, hi] : null;
}

export class DisjointSet {
	constructor(n) {
		this.parent = Int32Array.from({ length: n }, (_, i) => i);
		this.size = new Int32Array(n).fill(1);
	}
	find(i) {
		while (this.parent[i] !== i) {
			this.parent[i] = this.parent[this.parent[i]];
			i = this.parent[i];
		}
		return i;
	}
	union(a, b) {
		a = this.find(a);
		b = this.find(b);
		if (a === b) return;
		if (this.size[a] < this.size[b]) [a, b] = [b, a];
		this.parent[b] = a;
		this.size[a] += this.size[b];
	}
}
