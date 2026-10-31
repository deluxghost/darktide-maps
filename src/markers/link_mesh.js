const SUBDIVISION_STEP = 8;
const BODY_JOIN_SEGMENTS = 2;
const CORNER_JOIN_SEGMENTS = 4;

function curvature({start, left, right, end}) {
	return Math.max(Math.hypot(start.x - 2 * left.x + right.x, start.y - 2 * left.y + right.y),
		Math.hypot(left.x - 2 * right.x + end.x, left.y - 2 * right.y + end.y));
}

export function markerLinkSegments(geometry, tolerance) {
	const {left, right} = geometry.edges;
	const required = Math.sqrt(0.75 * Math.max(curvature(left), curvature(right)) / tolerance);
	// Round upward so small camera changes reuse the same GPU topology.
	return Math.max(1, Math.ceil(required / SUBDIVISION_STEP) * SUBDIVISION_STEP);
}

export function markerLinkTemplate(segments) {
	const points = 2 * (segments + 1) + 3, rows = [];
	let part = 0;
	function vertex(point, edge = 0, side = 0, kind = 0) {
		rows.push(point, edge, side, kind, part, 0);
	}
	function fill() {
		for (let index = 1; index <= segments; index++) {
			vertex(index - 1); vertex(points - index); vertex(index);
			vertex(index); vertex(points - index); vertex(points - 1 - index);
		}
		vertex(segments + 1); vertex(segments + 2); vertex(segments + 3);
	}
	fill();
	part = 1;
	for (let index = 0; index < points; index++) {
		const next = (index + 1) % points;
		vertex(index, index, 1, 1); vertex(index, index, -1, 1); vertex(next, index, 1, 1);
		vertex(next, index, 1, 1); vertex(index, index, -1, 1); vertex(next, index, -1, 1);
		const corner = index === 0 || index === points - 1 || index >= segments && index <= segments + 4;
		const joins = corner ? CORNER_JOIN_SEGMENTS : BODY_JOIN_SEGMENTS;
		for (let join = 0; join < joins; join++) {
			vertex(index); vertex(index, 0, join / joins, 2); vertex(index, 0, (join + 1) / joins, 2);
		}
	}
	part = 2;
	fill();
	return new Float32Array(rows);
}

export function writeMarkerLink(data, offset, arrow, segments) {
	// Eight RGBA texels hold both curve edges, the head, and two colors.
	const {left, right} = arrow.geometry.edges;
	const leftPoints = [left.start, left.left, left.right, left.end];
	const rightPoints = [right.start, right.left, right.right, right.end];
	for (let index = 0; index < 4; index++) {
		const a = leftPoints[index], b = rightPoints[index];
		data.set([a.x, a.y, b.x, b.y], offset + index * 4);
	}
	const [a, b, c] = arrow.geometry.head;
	data.set([a.x, a.y, b.x, b.y, c.x, c.y, 0, segments], offset + 16);
	const [red, green, blue, alpha = 255] = arrow.color;
	data.set([red / 255, green / 255, blue / 255, alpha / 255,
		Math.round(red * 0.28) / 255, Math.round(green * 0.28) / 255, Math.round(blue * 0.28) / 255, 1], offset + 24);
}
