const BODY_RADIUS_RATIO = 0.4;
const BODY_SAMPLES = [[0, 0], [-0.55, 0], [0.55, 0], [0, -0.55], [0, 0.55]];

export function boxesOverlap(left, right) {
	return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

export function visibleMarkerPoints(points, bounds, forcedIds) {
	const front = points.filter((point) => forcedIds.has(point.marker.id)
		|| point.x + point.width >= bounds.left && point.x - point.width <= bounds.right
		&& point.y + point.height >= bounds.top && point.y - point.height <= bounds.bottom)
		.sort((left, right) => right.depth - left.depth || right.order - left.order);
	const visible = new Map();
	for (let index = 0; index < front.length; index++) {
		const point = front[index];
		const radius = point.width * BODY_RADIUS_RATIO;
		const samples = BODY_SAMPLES.filter(([x, y]) => {
			const sampleX = point.x + x * radius, sampleY = point.y + y * radius;
			for (let nearer = 0; nearer < index; nearer++) {
				const other = front[nearer], otherRadius = other.width * BODY_RADIUS_RATIO;
				if ((sampleX - other.x) ** 2 + (sampleY - other.y) ** 2 < otherRadius ** 2) return false;
			}
			return true;
		}).length;
		if (samples || forcedIds.has(point.marker.id)) {
			visible.set(point.marker.id, {...point, visibleSamples: samples || BODY_SAMPLES.length});
		}
	}
	return visible;
}

export function spreadTooltipLabels(candidates, anchors, place, limit) {
	const remaining = [...candidates], selected = [], covered = [...anchors];
	while (remaining.length && selected.length < limit) {
		let best = 0, score = -Infinity;
		for (let index = 0; index < remaining.length; index++) {
			const candidate = remaining[index];
			const distance = Math.min(...covered.map((point) => (point.x - candidate.x) ** 2 + (point.y - candidate.y) ** 2));
			const value = distance * candidate.visibleSamples;
			if (value > score) {best = index; score = value;}
		}
		const point = remaining.splice(best, 1)[0];
		const label = place(point);
		if (!label) continue;
		selected.push(label);
		covered.push(point);
	}
	return selected;
}
