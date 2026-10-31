import { APP_CONFIG } from "../config.js";

const BOX_AXES = [["x", "left", "right"], ["y", "top", "bottom"]];

function normalize(vector) {
	const length = Math.hypot(vector.x, vector.y);

	if (length <= 0) {
		return null;
	}

	return {
		x: vector.x / length,
		y: vector.y / length,
	};
}

function offsetPoint(point, direction, distance) {
	return {
		x: point.x + direction.x * distance,
		y: point.y + direction.y * distance,
	};
}

function angleOf(vector) {
	return Math.atan2(vector.y, vector.x);
}

function normalizeAngle(angle) {
	let value = angle;

	while (value <= -Math.PI) {
		value += Math.PI * 2;
	}

	while (value > Math.PI) {
		value -= Math.PI * 2;
	}

	return value;
}

function directionFromAngle(angle) {
	return {
		x: Math.cos(angle),
		y: Math.sin(angle),
	};
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function auxiliaryArrowControl(start, end) {
	const direction = normalize({
		x: end.x - start.x,
		y: end.y - start.y,
	});

	if (!direction) {
		return {
			x: (start.x + end.x) / 2,
			y: (start.y + end.y) / 2,
		};
	}

	const midpoint = {
		x: (start.x + end.x) / 2,
		y: (start.y + end.y) / 2,
	};
	const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
	const distance = Math.hypot(end.x - start.x, end.y - start.y);
	const horizontalness = Math.abs(direction.x);
	const firstNormal = {x: -direction.y, y: direction.x};
	const secondNormal = {x: -firstNormal.x, y: -firstNormal.y};
	const verticalEpsilon = 0.0001;
	const upperNormal = Math.abs(firstNormal.y - secondNormal.y) <= verticalEpsilon
		? null
		: (firstNormal.y < secondNormal.y ? firstNormal : secondNormal);

	if (!upperNormal) {
		return midpoint;
	}

	const curve = distance * links.arcDistanceRatio * horizontalness;
	const maxTilt = links.arcMaxTiltDegrees * Math.PI / 180;
	const upwardAngle = -Math.PI / 2;
	const normalAngle = angleOf(upperNormal);
	const controlAngle = normalAngle + clamp(
		normalizeAngle(upwardAngle - normalAngle),
		-maxTilt,
		maxTilt,
	);
	const controlDirection = directionFromAngle(controlAngle);

	return offsetPoint(midpoint, controlDirection, curve);
}

function quadraticPoint(start, control, end, t) {
	const inverse = 1 - t;

	return {
		x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
		y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
	};
}

function sampleCurve(start, control, end, samples) {
	const points = [];
	let length = 0;
	let previous = null;

	for (let index = 0; index <= samples; index++) {
		const point = quadraticPoint(start, control, end, index / samples);

		if (previous) {
			length += Math.hypot(point.x - previous.x, point.y - previous.y);
		}

		point.length = length;
		point.t = index / samples;
		points.push(point);
		previous = point;
	}

	return {
		length,
		points,
	};
}

function curveTangentAtStart(start, control) {
	return normalize({
		x: control.x - start.x,
		y: control.y - start.y,
	});
}

function curveTangentAtEnd(end, control) {
	return normalize({
		x: end.x - control.x,
		y: end.y - control.y,
	});
}

function boundaryCurve(points, tangent) {
	const start = points[0], end = points[points.length - 1];
	if (points.length < 5) {
		const direction = normalize({x: points[1].x - start.x, y: points[1].y - start.y});
		const handle = Math.hypot(end.x - start.x, end.y - start.y) / 3;
		return {start, left: offsetPoint(start, direction, handle), right: offsetPoint(end, tangent, -handle), end};
	}
	// Constrain the end tangent to the head axis so the neck and wings meet squarely.
	const parameter = (point) => (point.t - start.t) / (end.t - start.t);
	let aa = 0, ab = 0, bb = 0, ax = 0, ay = 0, bx = 0, by = 0;
	for (let index = 1; index < points.length - 1; index++) {
		const point = points[index], t = parameter(point), u = 1 - t;
		const a = 3 * u * u * t, b = 3 * u * t * t;
		const x = point.x - u ** 3 * start.x - (b + t ** 3) * end.x;
		const y = point.y - u ** 3 * start.y - (b + t ** 3) * end.y;
		aa += a * a; ab += a * b; bb += b * b;
		ax += a * x; ay += a * y; bx += b * x; by += b * y;
	}
	const handle = (-(bx * tangent.x + by * tangent.y) + ab * (ax * tangent.x + ay * tangent.y) / aa)
		/ (bb - ab * ab / aa);
	const left = {x: (ax + ab * tangent.x * handle) / aa, y: (ay + ab * tangent.y * handle) / aa};
	return {start, left, right: offsetPoint(end, tangent, -handle), end};
}

function arrowShape(centerline) {
	const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
	const tip = centerline[centerline.length - 1];
	const totalLength = centerline[centerline.length - 1]?.length ?? 0;
	const baseDistance = totalLength - links.arrowHeadLength;
	if (baseDistance <= links.arcWidth * 2) return null;
	const base = pointOnCenterline(centerline, baseDistance);
	const tangent = normalize({x: tip.x - base.x, y: tip.y - base.y});
	const headNormal = {x: -tangent.y, y: tangent.x};
	const shaftHalfWidth = links.arcWidth / 2;
	const left = [], right = [];
	const shaft = centerline.filter((point) => point.length < baseDistance).concat(base);
	if (shaft.length < 2) return null;
	for (let index = 0; index < shaft.length; index++) {
		const point = shaft[index];
		const next = shaft[Math.min(shaft.length - 1, index + 1)];
		const previous = shaft[Math.max(0, index - 1)];
		const direction = normalize({x: next.x - previous.x, y: next.y - previous.y});
		if (!direction) continue;
		const normal = index === shaft.length - 1 ? headNormal : {x: -direction.y, y: direction.x};
		left.push({...offsetPoint(point, normal, shaftHalfWidth), t: point.t});
		right.push({...offsetPoint(point, {x: -normal.x, y: -normal.y}, shaftHalfWidth), t: point.t});
	}
	const headLeft = offsetPoint(base, headNormal, links.arrowHeadWidth / 2);
	const headRight = offsetPoint(base, {x: -headNormal.x, y: -headNormal.y}, links.arrowHeadWidth / 2);
	const edges = {left: boundaryCurve(left, tangent), right: boundaryCurve(right, tangent)};
	const reversedPoints = [...right].reverse();
	const points = [...left, headLeft, tip, headRight, ...reversedPoints];
	const bounds = {left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity};
	for (const point of points) {
		bounds.left = Math.min(bounds.left, point.x);
		bounds.right = Math.max(bounds.right, point.x);
		bounds.top = Math.min(bounds.top, point.y);
		bounds.bottom = Math.max(bounds.bottom, point.y);
	}
	return {outline: points, bounds, edges, head: [headLeft, tip, headRight]};
}

function pointOnCenterline(centerline, distance) {
	for (let index = 1; index < centerline.length; index++) {
		const previous = centerline[index - 1], current = centerline[index];
		if (current.length < distance) continue;
		const span = current.length - previous.length;
		const t = span > 0 ? (distance - previous.length) / span : 0;
		return {
			x: previous.x + (current.x - previous.x) * t,
			y: previous.y + (current.y - previous.y) * t,
			length: distance,
			t: previous.t + (current.t - previous.t) * t,
		};
	}
	return centerline[centerline.length - 1];
}

function mix(left, right, t) {
	return left + (right - left) * t;
}

function pinGapForDirection(direction, scale) {
	const pins = APP_CONFIG.runtime.visual.pins;
	const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
	const horizontalRadius = pins.iconWidth * scale * 0.5;
	const bottomRadius = pins.iconHeight * scale * 0.64;
	const bottomFactor = Math.max(0, direction.y) ** 2;

	return mix(horizontalRadius, bottomRadius, bottomFactor) + links.arrowPadding;
}

export function markerLinkGeometry(points, {startScale = 1, endScale = 1} = {}) {
	const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
	const baseControl = auxiliaryArrowControl(points.start, points.end);
	const startTangent = curveTangentAtStart(points.start, baseControl);
	const endTangent = curveTangentAtEnd(points.end, baseControl);

	if (!startTangent || !endTangent) {
		return null;
	}

	const startGap = pinGapForDirection(startTangent, startScale);
	const endDirection = {x: -endTangent.x, y: -endTangent.y};
	const endGap = pinGapForDirection(endDirection, endScale);
	const start = offsetPoint(points.start, startTangent, startGap);
	const end = offsetPoint(points.end, endDirection, endGap);
	// Pin clearance can move the endpoints past each other at close range.
	const advance = (end.x - start.x) * (points.end.x - points.start.x)
		+ (end.y - start.y) * (points.end.y - points.start.y);
	if (advance <= 0) return null;
	const control = auxiliaryArrowControl(start, end);
	// A quadratic segment's maximum chord error is curvature / (4 * samples^2).
	const curvature = Math.hypot(start.x - 2 * control.x + end.x, start.y - 2 * control.y + end.y);
	const samples = Math.max(2, Math.ceil(Math.sqrt(curvature / (4 * links.arcPixelTolerance))));
	const curve = sampleCurve(start, control, end, samples);
	const minimumLength = links.arrowHeadLength + links.arcWidth * 2;

	if (curve.length < minimumLength) {
		return null;
	}

	return arrowShape(curve.points);
}

function segmentLengthInBox(start, end, bounds) {
	if (Math.max(start.x, end.x) < bounds.left || Math.min(start.x, end.x) > bounds.right
		|| Math.max(start.y, end.y) < bounds.top || Math.min(start.y, end.y) > bounds.bottom) return 0;
	let lower = 0, upper = 1;
	for (const [axis, minimumKey, maximumKey] of BOX_AXES) {
		const minimum = bounds[minimumKey], maximum = bounds[maximumKey];
		const delta = end[axis] - start[axis];
		if (delta === 0) {
			if (start[axis] < minimum || start[axis] > maximum) return 0;
			continue;
		}
		const first = (minimum - start[axis]) / delta, last = (maximum - start[axis]) / delta;
		lower = Math.max(lower, Math.min(first, last));
		upper = Math.min(upper, Math.max(first, last));
		if (lower >= upper) return 0;
	}
	return (upper - lower) * Math.hypot(end.x - start.x, end.y - start.y);
}

export function markerLinkOverlap({shapes, offset}, bounds) {
	const padding = APP_CONFIG.runtime.visual.auxiliaryLinks.tooltipLinePadding;
	const box = {left: bounds.left - padding - offset.x, right: bounds.right + padding - offset.x,
		top: bounds.top - padding - offset.y, bottom: bounds.bottom + padding - offset.y};
	let length = 0;
	for (const {outline, bounds: shape} of shapes) {
		if (shape.left > box.right || shape.right < box.left || shape.top > box.bottom || shape.bottom < box.top) continue;
		for (let index = 0; index < outline.length; index++) {
			length += segmentLengthInBox(outline[index], outline[(index + 1) % outline.length], box);
		}
	}
	return length;
}
