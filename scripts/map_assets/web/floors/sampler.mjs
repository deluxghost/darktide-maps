import { BufferAttribute, BufferGeometry, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";
import {clip, faceArea} from "./geometry.mjs";

function interpolate(a, b, t) {
	return a.map((value, axis) => value + (b[axis] - value) * t);
}

function sameLabel(a, b) {
	return Array.isArray(a) ? a.every((value, index) => value === b?.[index]) : a === b;
}

function floorCoordinate(label) {
	return Array.isArray(label) ? label.map((floor) => floor + 0.5) : label + 0.5;
}

// Split only at horizontal analysis planes, not XY cells. Labels are scalars or arrays when multiple partitions
// share the same plane lattice.
function sampling(graph, labelAt) {
	function splitPath(path, verticalOffset = 0) {
		const result = [];
		for (let index = 1; index < path.length; index++) {
			const a = path[index - 1],
				b = path[index];
			const low = Math.min(a[2], b[2]) - verticalOffset;
			const high = Math.max(a[2], b[2]) - verticalOffset;
			const parameters = [0, 1];
			for (
				let band = Math.floor((low - graph.base) / graph.step) + 1;
				graph.base + band * graph.step < high;
				band++
			) {
				parameters.push(
					(graph.base + band * graph.step + verticalOffset - a[2]) /
						(b[2] - a[2]),
				);
			}
			parameters.sort((left, right) => left - right);
			for (let part = 1; part < parameters.length; part++) {
				const start = interpolate(a, b, parameters[part - 1]);
				const end = interpolate(a, b, parameters[part]);
				const middle = interpolate(start, end, 0.5);
				middle[2] -= verticalOffset;
				const floorIndex = labelAt(middle);
				const previous = result.at(-1);
				if (previous && sameLabel(previous.floorIndex, floorIndex)) {
					if (part > 1) previous.path.pop();
					previous.path.push(end);
				} else {
					result.push({ path: [start, end], floorIndex });
				}
			}
		}
		return result;
	}

	// sources: the input triangle of every output triangle
	function labelMesh(mesh, {verticalOffset = 0} = {}) {
		const result = {positions: [], normals: [], indices: [], floorIds: [], sources: []};
		const lookup = new Map();
		for (let index = 0; index < mesh.indices.length; index += 3) {
			const vertices = mesh.indices.slice(index, index + 3);
			const points = vertices.map(vertex => new Vector3().fromArray(mesh.positions, vertex * 3));
			const low = Math.min(...points.map(point => point.z)) - verticalOffset;
			const high = Math.max(...points.map(point => point.z)) - verticalOffset;
			const firstBand = Math.floor((low - graph.base) / graph.step);
			const lastBand = Math.floor((high - graph.base) / graph.step);
			const normal = mesh.normals.slice(vertices[0] * 3, vertices[0] * 3 + 3).map(Math.fround);
			let slicedArea = 0, first, last, floor;
			function flush() {
				if (first === undefined) return;
				const face = clip(clip(points, graph.base + first * graph.step + verticalOffset, true),
					graph.base + (last + 1) * graph.step + verticalOffset, false);
				for (let corner = 1; corner + 1 < face.length; corner++) {
					const triangle = [face[0], face[corner], face[corner + 1]];
					const area = faceArea(triangle);
					if (area === 0) continue;
					slicedArea += area;
					for (const point of triangle) {
						const position = point.toArray().map(Math.fround);
						const key = [...position, ...normal, floor].join(":");
						if (!lookup.has(key)) {
							lookup.set(key, result.floorIds.length);
							result.positions.push(...position);
							result.normals.push(...normal);
							result.floorIds.push(floorCoordinate(floor));
						}
						result.indices.push(lookup.get(key));
					}
					result.sources.push(index / 3);
				}
			}
			for (let band = firstBand; band <= lastBand; band++) {
				const face = clip(clip(points, graph.base + band * graph.step + verticalOffset, true),
					graph.base + (band + 1) * graph.step + verticalOffset, false);
				if (faceArea(face) === 0) continue;
				const center = face.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(face.length);
				center.z -= verticalOffset;
				const label = labelAt(center.toArray());
				if (!sameLabel(floor, label)) {
					flush();
					first = band;
					floor = label;
				}
				last = band;
			}
			flush();
			if (Math.abs(faceArea(points) - slicedArea) > 1e-7) {
				throw new Error(`Layer transfer lost surface area at triangle ${index / 3}.`);
			}
		}
		return result;
	}

	return { floorAt: labelAt, splitPath, labelMesh };
}

export function createFloorSampler(mesh, graph) {
	const geometry = new BufferGeometry();
	geometry.setAttribute(
		"position",
		new BufferAttribute(Float32Array.from(mesh.positions), 3),
	);
	geometry.setIndex(new BufferAttribute(Uint32Array.from(mesh.indices), 1));
	const bvh = new MeshBVH(geometry, { indirect: true });
	const point = new Vector3();
	const hit = {};

	function floorAt(position) {
		point.fromArray(position);
		const nearest = bvh.closestPointToPoint(point, hit);
		if (!nearest) throw new Error(`No floor surface near ${position}.`);
		return mesh.labels[mesh.indices[nearest.faceIndex * 3]];
	}

	return { ...sampling(graph, floorAt), graph };
}

// A shared analysis-plane lattice lets one cut pass label every partition.
export function combineFloorSamplers(...samplers) {
	const {graph} = samplers[0];
	if (samplers.some((sampler) => sampler.graph.step !== graph.step
		|| Math.abs(Math.round((sampler.graph.base - graph.base) / graph.step) * graph.step - (sampler.graph.base - graph.base)) > 1e-6)) {
		throw new Error("Combined floor partitions do not share their analysis planes.");
	}
	return { ...sampling(graph, (position) => samplers.map((sampler) => sampler.floorAt(position))), graph };
}
