const COMPONENT_KEY_PRECISION = 3;

export function subtract(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(vector, amount) {
	return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

export function midpoint(a, b) {
	return scale(add(a, b), 0.5);
}

export function lerp(a, b, amount) {
	return [
		a[0] + (b[0] - a[0]) * amount,
		a[1] + (b[1] - a[1]) * amount,
		a[2] + (b[2] - a[2]) * amount,
	];
}

export function edgeLength(edge) {
	return Math.hypot(
		edge.a[0] - edge.b[0],
		edge.a[1] - edge.b[1],
		edge.a[2] - edge.b[2],
	);
}

export function triangleArea(a, b, c) {
	const ab = subtract(b, a);
	const ac = subtract(c, a);
	const cross = [
		ab[1] * ac[2] - ab[2] * ac[1],
		ab[2] * ac[0] - ab[0] * ac[2],
		ab[0] * ac[1] - ab[1] * ac[0],
	];

	return Math.hypot(cross[0], cross[1], cross[2]) / 2;
}

export function triangleCenter(vertices, triangle) {
	const a = vertices[triangle[0] - 1];
	const b = vertices[triangle[1] - 1];
	const c = vertices[triangle[2] - 1];

	return scale(add(add(a, b), c), 1 / 3);
}

function precisePositionKey(position) {
	return position.map((value) => value.toFixed(6)).join(",");
}

export function preciseEdgeKey(a, b) {
	const left = precisePositionKey(a);
	const right = precisePositionKey(b);

	return left < right
		? `${left}|${right}`
		: `${right}|${left}`;
}

export function positionKey(position) {
	return position.map((value) => value.toFixed(COMPONENT_KEY_PRECISION)).join(",");
}

export function distance2d(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointOnSegment2d(point, a, b) {
	const cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1]);

	if (Math.abs(cross) > 1e-6) {
		return false;
	}

	const dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]);

	if (dot < 0) {
		return false;
	}

	const lengthSquared = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;

	return dot <= lengthSquared;
}

export function pointInPolygon2d(point, polygon) {
	let inside = false;

	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		const currentPoint = polygon[index];
		const previousPoint = polygon[previous];

		if (pointOnSegment2d(point, previousPoint, currentPoint)) {
			return true;
		}

		const intersects = (currentPoint[1] > point[1]) !== (previousPoint[1] > point[1])
			&& point[0] < (
				(previousPoint[0] - currentPoint[0])
				* (point[1] - currentPoint[1])
				/ (previousPoint[1] - currentPoint[1])
				+ currentPoint[0]
			);

		if (intersects) {
			inside = !inside;
		}
	}

	return inside;
}

export function pointToSegmentDistance2d(point, a, b) {
	const segment = [b[0] - a[0], b[1] - a[1]];
	const relative = [point[0] - a[0], point[1] - a[1]];
	const lengthSquared = segment[0] * segment[0] + segment[1] * segment[1];

	if (lengthSquared === 0) {
		return distance2d(point, a);
	}

	const amount = Math.max(0, Math.min(1, (
		relative[0] * segment[0] + relative[1] * segment[1]
	) / lengthSquared));

	return distance2d(point, [
		a[0] + segment[0] * amount,
		a[1] + segment[1] * amount,
	]);
}

export function polygonDistance2d(point, polygon) {
	let result = Infinity;

	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		result = Math.min(result, pointToSegmentDistance2d(point, polygon[previous], polygon[index]));
	}

	return result;
}
