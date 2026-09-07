import { BufferAttribute, BufferGeometry, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";

function interpolate(a, b, t) {
	return a.map((value, axis) => value + (b[axis] - value) * t);
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

	function splitPath(path, verticalOffset = 0) {
		const result = [];
		for (let index = 1; index < path.length; index++) {
			const a = path[index - 1],
				b = path[index];
			const low = Math.min(a[2], b[2]) - verticalOffset;
			const high = Math.max(a[2], b[2]) - verticalOffset;
			const parameters = [0, 1];
			// Surface ownership changes at horizontal analysis planes, never XY cells.
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
				const floorIndex = floorAt(middle);
				const previous = result.at(-1);
				if (previous?.floorIndex === floorIndex) {
					if (part > 1) previous.path.pop();
					previous.path.push(end);
				} else {
					result.push({ path: [start, end], floorIndex });
				}
			}
		}
		return result;
	}

	function labelMesh(mesh) {
		const result = { positions: [], normals: [], indices: [], floorIds: [] };
		for (let index = 0; index < mesh.indices.length; index += 3) {
			const vertices = mesh.indices.slice(index, index + 3);
			const center = [0, 0, 0];
			for (const vertex of vertices)
				for (let axis = 0; axis < 3; axis++)
					center[axis] += mesh.positions[vertex * 3 + axis] / 3;
			const floor = floorAt(center) + 0.5;
			for (const vertex of vertices) {
				result.indices.push(result.floorIds.length);
				result.positions.push(
					...mesh.positions.slice(vertex * 3, vertex * 3 + 3),
				);
				result.normals.push(...mesh.normals.slice(vertex * 3, vertex * 3 + 3));
				result.floorIds.push(floor);
			}
		}
		return result;
	}

	return { floorAt, splitPath, labelMesh };
}
