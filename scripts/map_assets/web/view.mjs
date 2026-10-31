import {BUILD_CONFIG} from "./config.mjs";

const VIEW = BUILD_CONFIG.view;

function boundsFromVertices(vertices) {
	const min = [Infinity, Infinity];
	const max = [-Infinity, -Infinity];

	for (const vertex of vertices) {
		min[0] = Math.min(min[0], vertex[0]);
		min[1] = Math.min(min[1], vertex[1]);
		max[0] = Math.max(max[0], vertex[0]);
		max[1] = Math.max(max[1], vertex[1]);
	}

	return {min, max};
}

function markGridCell(grid, cellX, cellY, size) {
	if (cellX < 0 || cellY < 0 || cellX >= size || cellY >= size) {
		return;
	}

	grid[cellY * size + cellX] = true;
}

function markTriangleOccupancy(grid, bounds, a, b, c) {
	const size = VIEW.fitGridSize;
	const width = bounds.max[0] - bounds.min[0];
	const height = bounds.max[1] - bounds.min[1];

	if (width <= 0 || height <= 0) {
		return;
	}

	const minX = Math.floor((Math.min(a[0], b[0], c[0]) - bounds.min[0]) / width * (size - 1));
	const maxX = Math.ceil((Math.max(a[0], b[0], c[0]) - bounds.min[0]) / width * (size - 1));
	const minY = Math.floor((Math.min(a[1], b[1], c[1]) - bounds.min[1]) / height * (size - 1));
	const maxY = Math.ceil((Math.max(a[1], b[1], c[1]) - bounds.min[1]) / height * (size - 1));
	const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);

	if (denominator === 0) {
		for (let cellY = minY; cellY <= maxY; cellY++) {
			for (let cellX = minX; cellX <= maxX; cellX++) {
				markGridCell(grid, cellX, cellY, size);
			}
		}

		return;
	}

	for (let cellY = minY; cellY <= maxY; cellY++) {
		for (let cellX = minX; cellX <= maxX; cellX++) {
			const x = bounds.min[0] + (cellX + 0.5) / size * width;
			const y = bounds.min[1] + (cellY + 0.5) / size * height;
			const alpha = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
			const beta = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
			const gamma = 1 - alpha - beta;

			if (alpha >= 0 && beta >= 0 && gamma >= 0) {
				markGridCell(grid, cellX, cellY, size);
			}
		}
	}
}

function occupiedCells(grid) {
	const size = VIEW.fitGridSize;
	const occupied = [];

	for (let index = 0; index < grid.length; index++) {
		if (grid[index]) {
			occupied.push({
				x: index % size,
				y: Math.floor(index / size),
			});
		}
	}

	return occupied;
}

function cellCenter(bounds, cellX, cellY) {
	const size = VIEW.fitGridSize;

	return [
		bounds.min[0] + (cellX + 0.5) / size * (bounds.max[0] - bounds.min[0]),
		bounds.min[1] + (cellY + 0.5) / size * (bounds.max[1] - bounds.min[1]),
	];
}

function occupiedArea(bounds, occupied) {
	const size = VIEW.fitGridSize;
	const width = bounds.max[0] - bounds.min[0];
	const height = bounds.max[1] - bounds.min[1];

	return occupied.length * width * height / (size * size);
}

function cross(origin, a, b) {
	return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function convexHull(points) {
	const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

	if (sorted.length <= 1) {
		return sorted;
	}

	const lower = [];

	for (const point of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
			lower.pop();
		}

		lower.push(point);
	}

	const upper = [];

	for (let index = sorted.length - 1; index >= 0; index--) {
		const point = sorted[index];

		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
			upper.pop();
		}

		upper.push(point);
	}

	lower.pop();
	upper.pop();

	return [...lower, ...upper];
}

export function createViewMetadata(data) {
	const bounds = boundsFromVertices(data.vertices);
	const grid = new Array(VIEW.fitGridSize * VIEW.fitGridSize).fill(false);

	for (const triangle of data.triangles) {
		markTriangleOccupancy(
			grid,
			bounds,
			data.vertices[triangle[0] - 1],
			data.vertices[triangle[1] - 1],
			data.vertices[triangle[2] - 1],
		);
	}

	const occupied = occupiedCells(grid);

	if (occupied.length === 0) {
		return undefined;
	}

	const points = occupied.map((cell) => cellCenter(bounds, cell.x, cell.y));

	return {
		projectedArea: occupiedArea(bounds, occupied),
		projectedHull: convexHull(points),
	};
}
