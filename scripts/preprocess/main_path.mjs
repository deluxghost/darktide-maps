import {PREPROCESS_CONFIG} from "./config.mjs";
import {arrayFromLuaJson} from "./utils.mjs";

const MAIN_PATH = PREPROCESS_CONFIG.mainPath;

function createMesh() {
	return {
		positions: [],
		normals: [],
		indices: [],
		floorIds: [],
	};
}

function pushVertex(mesh, position, normal, floor) {
	mesh.positions.push(position[0], position[1], position[2]);
	mesh.normals.push(normal[0], normal[1], normal[2]);
	mesh.floorIds.push(floor);

	return mesh.positions.length / 3 - 1;
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

function addCone(mesh, baseCenter, tip, radius, floor) {
	const direction = subtract(tip, baseCenter);
	const {forward, right, normal} = basisForDirection(direction);
	const sides = MAIN_PATH.arrowSides;
	const base = [];
	const tipIndex = pushVertex(mesh, tip, forward, floor);
	const baseCenterIndex = pushVertex(mesh, baseCenter, scale(forward, -1), floor);

	for (let side = 0; side < sides; side++) {
		const angle = side / sides * Math.PI * 2;
		const radial = normalize(add(scale(right, Math.cos(angle)), scale(normal, Math.sin(angle))));

		base.push(pushVertex(
			mesh,
			add(baseCenter, scale(radial, radius)),
			normalize(add(radial, scale(forward, 0.45))),
			floor,
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

function addTubeCap(mesh, center, ring, normal, reverse, floor) {
	const centerIndex = pushVertex(mesh, center, normal, floor);

	for (let side = 0; side < ring.length; side++) {
		const next = (side + 1) % ring.length;

		if (reverse) {
			mesh.indices.push(centerIndex, ring[next], ring[side]);
		} else {
			mesh.indices.push(centerIndex, ring[side], ring[next]);
		}
	}
}

function addTubePath(mesh, nodes, radius, floorAt) {
	if (nodes.length < 2) {
		return;
	}

	const sides = MAIN_PATH.tubeSides;
	const rings = [];

	for (let index = 0; index < nodes.length; index++) {
		const {right, normal} = basisForDirection(tangentAt(nodes, index));
		const ring = [];
		const floor = floorAt(nodes[index]);

		for (let side = 0; side < sides; side++) {
			const angle = side / sides * Math.PI * 2;
			const radial = normalize(add(scale(right, Math.cos(angle)), scale(normal, Math.sin(angle))));

			ring.push(pushVertex(
				mesh,
				add(nodes[index], scale(radial, radius)),
				radial,
				floor,
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

	addTubeCap(mesh, nodes[0], rings[0], scale(normalize(tangentAt(nodes, 0)), -1), true, floorAt(nodes[0]));
	addTubeCap(mesh, nodes[nodes.length - 1], rings[rings.length - 1], normalize(tangentAt(nodes, nodes.length - 1)), false, floorAt(nodes.at(-1)));
}

function pointBetween(start, end, amount) {
	return [
		start[0] + (end[0] - start[0]) * amount,
		start[1] + (end[1] - start[1]) * amount,
		start[2] + (end[2] - start[2]) * amount,
	];
}

function addDashedTube(mesh, start, end, floorAt) {
	const length = distance(start, end);
	const gapLength = MAIN_PATH.segmentConnectorGapLength;
	const dashLength = MAIN_PATH.segmentConnectorDashLength;
	const endAt = length - gapLength;
	const startFloor = floorAt(start), endFloor = floorAt(end);
	// A connector spans missing path data; interpolate its endpoint ownership monotonically.
	const connectorFloor = (point) => startFloor + (endFloor - startFloor) * distance(start, point) / length;

	if (length <= gapLength * 2 || dashLength <= 0 || gapLength < 0) {
		return;
	}

	for (let from = gapLength; from < endAt; from += dashLength + gapLength) {
		const to = Math.min(from + dashLength, endAt);

		if (to <= from) {
			continue;
		}

		addTubePath(mesh, [
			pointBetween(start, end, from / length),
			pointBetween(start, end, to / length),
		], MAIN_PATH.tubeRadius, connectorFloor);
	}
}

function addSegmentConnectors(mesh, segments, floorAt) {
	for (let index = 1; index < segments.length; index++) {
		const previous = segments[index - 1];
		const current = segments[index];

		addDashedTube(mesh, previous[previous.length - 1], current[0], floorAt);
	}
}

function addSphere(mesh, center, radius, floor) {
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

			row.push(pushVertex(mesh, add(center, scale(normal, radius)), normal, floor));
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

function addSegmentEndArrow(mesh, nodes, floor) {
	if (nodes.length < 2) {
		return;
	}

	const base = nodes[nodes.length - 1];
	const previous = nodes[nodes.length - 2];
	const direction = normalize(subtract(base, previous));
	const coneBase = add(base, scale(direction, -MAIN_PATH.arrowTailOverlap));
	const tip = add(base, scale(direction, MAIN_PATH.arrowTipOffset));

	addCone(mesh, coneBase, tip, MAIN_PATH.arrowRadius, floor);
}

export function createMainPathMeshes(data, floors) {
	const meshes = {
		tube: createMesh(),
		connectors: createMesh(),
		arrows: createMesh(),
		start: createMesh(),
	};
	const visibleSegments = arrayFromLuaJson(data.segments ?? [], "main path segments")
		.map((segment) => cleanNodes(arrayFromLuaJson(segment.nodes ?? [], "main path segment nodes")))
		.filter((nodes) => nodes.length >= 2);
	const floorAt = (point) => floors.floorAt([point[0], point[1], point[2] - MAIN_PATH.verticalOffset]) + 0.5;

	for (const nodes of visibleSegments) {
		for (const section of floors.splitPath(nodes, MAIN_PATH.verticalOffset)) {
			addTubePath(meshes.tube, section.path, MAIN_PATH.tubeRadius, () => section.floorIndex + 0.5);
		}
		addSegmentEndArrow(meshes.arrows, nodes, floorAt(nodes.at(-1)));
	}
	addSegmentConnectors(meshes.connectors, visibleSegments, floorAt);

	if (visibleSegments.length > 0) {
		const firstSegment = visibleSegments[0];

		addSphere(meshes.start, firstSegment[0], MAIN_PATH.startSphereRadius, floorAt(firstSegment[0]));
	}

	return meshes;
}

export function createMainPathSummary(data) {
	const nodes = arrayFromLuaJson(data.unified_nodes ?? [], "main path unified nodes")
		.filter((node) => typeof node.travel_distance === "number")
		.sort((left, right) => left.travel_distance - right.travel_distance);

	if (nodes.length < 2) {
		return null;
	}

	return {
		start: nodes[0].position,
		end: nodes[nodes.length - 1].position,
	};
}

export function createMainPathSampler(data) {
	const nodes = arrayFromLuaJson(data.unified_nodes ?? [], "main path unified nodes")
		.filter((node) => typeof node.travel_distance === "number")
		.sort((left, right) => left.travel_distance - right.travel_distance);

	if (nodes.length === 0) {
		throw new Error(`Main path ${data.mission} has no travel distance nodes.`);
	}

	return {
		positionAt(travelDistance) {
			if (typeof travelDistance !== "number") {
				throw new Error(`Main path ${data.mission} travel distance must be a number.`);
			}

			if (travelDistance < nodes[0].travel_distance || travelDistance > nodes[nodes.length - 1].travel_distance) {
				throw new Error(`Main path ${data.mission} travel distance is out of range: ${travelDistance}.`);
			}

			for (let index = 1; index < nodes.length; index++) {
				const left = nodes[index - 1];
				const right = nodes[index];

				if (travelDistance > right.travel_distance) {
					continue;
				}

				const distance = right.travel_distance - left.travel_distance;
				const amount = distance === 0
					? 0
					: (travelDistance - left.travel_distance) / distance;

				return left.position.map((value, axis) => value + (right.position[axis] - value) * amount);
			}

			return nodes[nodes.length - 1].position;
		},
	};
}
