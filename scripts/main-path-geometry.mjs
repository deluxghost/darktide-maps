import { VISUAL_CONFIG } from "../src/config.js";

const MAIN_PATH = VISUAL_CONFIG.build.mainPath;

function createMesh() {
	return {
		positions: [],
		normals: [],
		indices: [],
	};
}

function pushVertex(target, normalTarget, position, normal) {
	target.push(position[0], position[1], position[2]);
	normalTarget.push(normal[0], normal[1], normal[2]);

	return target.length / 3 - 1;
}

function subtract(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(vector, amount) {
	return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function cross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

function normalize(vector) {
	const length = Math.hypot(vector[0], vector[1], vector[2]);

	if (length === 0) {
		return [0, 0, 1];
	}

	return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function distance(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function basisForDirection(direction) {
	const forward = normalize(direction);
	const up = Math.abs(forward[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
	const right = normalize(cross(forward, up));
	const normal = normalize(cross(right, forward));

	return {forward, right, normal};
}

function offsetPoint(point) {
	return [point[0], point[1], point[2] + MAIN_PATH.verticalOffset];
}

function addCone(mesh, baseCenter, tip, radius) {
	const direction = subtract(tip, baseCenter);
	const {forward, right, normal} = basisForDirection(direction);
	const sides = MAIN_PATH.arrowSides;
	const base = [];
	const tipIndex = pushVertex(mesh.positions, mesh.normals, tip, forward);
	const baseCenterIndex = pushVertex(mesh.positions, mesh.normals, baseCenter, scale(forward, -1));

	for (let side = 0; side < sides; side++) {
		const angle = side / sides * Math.PI * 2;
		const radial = normalize(add(scale(right, Math.cos(angle)), scale(normal, Math.sin(angle))));

		base.push(pushVertex(
			mesh.positions,
			mesh.normals,
			add(baseCenter, scale(radial, radius)),
			normalize(add(radial, scale(forward, 0.45))),
		));
	}

	for (let side = 0; side < sides; side++) {
		const next = (side + 1) % sides;

		mesh.indices.push(base[side], tipIndex, base[next]);
		mesh.indices.push(baseCenterIndex, base[next], base[side]);
	}
}

function cleanNodes(nodes) {
	const clean = [];

	for (const node of nodes) {
		const point = offsetPoint(node);
		const previous = clean[clean.length - 1];

		if (!previous || distance(previous, point) >= 0.01) {
			clean.push(point);
		}
	}

	return clean;
}

function tangentAt(nodes, index) {
	if (index === 0) {
		return subtract(nodes[1], nodes[0]);
	}

	if (index === nodes.length - 1) {
		return subtract(nodes[index], nodes[index - 1]);
	}

	return add(
		normalize(subtract(nodes[index], nodes[index - 1])),
		normalize(subtract(nodes[index + 1], nodes[index])),
	);
}

function addTubeCap(mesh, center, ring, normal, reverse) {
	const centerIndex = pushVertex(mesh.positions, mesh.normals, center, normal);

	for (let side = 0; side < ring.length; side++) {
		const next = (side + 1) % ring.length;

		if (reverse) {
			mesh.indices.push(centerIndex, ring[next], ring[side]);
		} else {
			mesh.indices.push(centerIndex, ring[side], ring[next]);
		}
	}
}

function addTubePath(mesh, nodes, radius) {
	if (nodes.length < 2) {
		return;
	}

	const sides = MAIN_PATH.tubeSides;
	const rings = [];

	for (let index = 0; index < nodes.length; index++) {
		const {right, normal} = basisForDirection(tangentAt(nodes, index));
		const ring = [];

		for (let side = 0; side < sides; side++) {
			const angle = side / sides * Math.PI * 2;
			const radial = normalize(add(scale(right, Math.cos(angle)), scale(normal, Math.sin(angle))));

			ring.push(pushVertex(
				mesh.positions,
				mesh.normals,
				add(nodes[index], scale(radial, radius)),
				radial,
			));
		}

		rings.push(ring);
	}

	for (let index = 1; index < rings.length; index++) {
		const previous = rings[index - 1];
		const current = rings[index];

		for (let side = 0; side < sides; side++) {
			const next = (side + 1) % sides;

			mesh.indices.push(previous[side], current[side], current[next]);
			mesh.indices.push(previous[side], current[next], previous[next]);
		}
	}

	addTubeCap(mesh, nodes[0], rings[0], scale(normalize(tangentAt(nodes, 0)), -1), true);
	addTubeCap(mesh, nodes[nodes.length - 1], rings[rings.length - 1], normalize(tangentAt(nodes, nodes.length - 1)), false);
}

function addSphere(mesh, center, radius) {
	const latitudes = MAIN_PATH.sphereLatitudes;
	const longitudes = MAIN_PATH.sphereLongitudes;
	const rows = [];

	for (let latitude = 0; latitude <= latitudes; latitude++) {
		const phi = latitude / latitudes * Math.PI;
		const row = [];

		for (let longitude = 0; longitude < longitudes; longitude++) {
			const theta = longitude / longitudes * Math.PI * 2;
			const normal = [
				Math.sin(phi) * Math.cos(theta),
				Math.sin(phi) * Math.sin(theta),
				Math.cos(phi),
			];

			row.push(pushVertex(mesh.positions, mesh.normals, add(center, scale(normal, radius)), normal));
		}

		rows.push(row);
	}

	for (let latitude = 0; latitude < latitudes; latitude++) {
		for (let longitude = 0; longitude < longitudes; longitude++) {
			const next = (longitude + 1) % longitudes;

			mesh.indices.push(rows[latitude][longitude], rows[latitude + 1][longitude], rows[latitude + 1][next]);
			mesh.indices.push(rows[latitude][longitude], rows[latitude + 1][next], rows[latitude][next]);
		}
	}
}

function addSegmentEndArrow(mesh, nodes) {
	if (nodes.length < 2) {
		return;
	}

	const base = nodes[nodes.length - 1];
	const previous = nodes[nodes.length - 2];
	const direction = normalize(subtract(base, previous));
	const coneBase = add(base, scale(direction, -MAIN_PATH.arrowTailOverlap));
	const tip = add(base, scale(direction, MAIN_PATH.arrowTipOffset));

	addCone(mesh, coneBase, tip, MAIN_PATH.arrowRadius);
}

export function createMainPathMeshes(data) {
	const meshes = {
		tube: createMesh(),
		arrows: createMesh(),
		start: createMesh(),
	};
	const visibleSegments = (data.segments ?? [])
		.map((segment) => cleanNodes(segment.nodes ?? []))
		.filter((nodes) => nodes.length >= 2);

	for (const nodes of visibleSegments) {
		addTubePath(meshes.tube, nodes, MAIN_PATH.tubeRadius);
		addSegmentEndArrow(meshes.arrows, nodes);
	}

	if (visibleSegments.length > 0) {
		const firstSegment = visibleSegments[0];

		addSphere(meshes.start, firstSegment[0], MAIN_PATH.startSphereRadius);
	}

	return meshes;
}
