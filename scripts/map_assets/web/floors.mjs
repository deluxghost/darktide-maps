import { buildBandGraph } from "./floors/graph.mjs";
import { findOcclusion } from "./floors/occlusion.mjs";
import { partitionOrderedCut } from "./floors/ordered_cut.mjs";
import { compilePartition } from "./floors/compile.mjs";
import { createFloorSampler } from "./floors/sampler.mjs";
import { connectAttachments } from "./floors/attachments.mjs";
import { coalesceDisplayFloors } from "./floors/display.mjs";

export function createFloorSlices(navmesh) {
	const started = performance.now();
	const mesh = {
		positions: Float32Array.from(navmesh.vertices.flat()),
		indices: Uint32Array.from(
			navmesh.triangles.flatMap((triangle) =>
				triangle.slice(0, 3).map((index) => index - 1),
			),
		),
	};
	if (!mesh.indices.length)
		throw new Error(`${navmesh.mission}: cannot partition an empty navmesh.`);
	const graph = buildBandGraph(mesh);
	const occlusion = findOcclusion(graph);
	const attachmentStats = connectAttachments(graph, occlusion);
	const partition = coalesceDisplayFloors(graph, occlusion, partitionOrderedCut(graph, occlusion));
	const geometry = compilePartition(graph, partition);
	Object.assign(geometry.stats, partition.stats, attachmentStats, {
		algorithm: "ordered-cut-v4",
		totalMs: performance.now() - started,
	});
	const sampler = createFloorSampler(geometry, graph);
	const compiledNavmesh = {
		...navmesh,
		vertices: Array.from({ length: geometry.labels.length }, (_, index) =>
			geometry.positions.slice(index * 3, index * 3 + 3),
		),
		triangles: Array.from({ length: geometry.indices.length / 3 }, (_, index) =>
			geometry.indices
				.slice(index * 3, index * 3 + 3)
				.map((vertex) => vertex + 1),
		),
		floorIds: geometry.labels.map((floor) => floor + 0.5),
	};
	return {
		navmesh: compiledNavmesh,
		sampler,
		manifest: {
			algorithm: "ordered-cut-v4",
			layers: partition.levels.map((level, index) => ({
				id: `floor-${index}`,
				minZ: level.minZ,
				maxZ: level.maxZ,
			})),
			stats: geometry.stats,
		},
	};
}

export function assignMarkerFloors(markers, floors) {
	if (!markers?.pins?.length) return markers;
	return {
		...markers,
		pins: markers.pins.map((marker) => ({
			...marker,
			floorIndex: floors.sampler.floorAt(marker.position),
		})),
	};
}
