import {BufferAttribute, BufferGeometry, DoubleSide, Ray} from "three";
import {MeshBVH} from "three-mesh-bvh";

let mesh;
let geometry;
let floorIds;
let points;
let tolerance;
const ray = new Ray();

self.onmessage = ({data}) => {
	if (data.type === "map") {
		geometry?.dispose();
		geometry = new BufferGeometry();
		geometry.setAttribute("position", new BufferAttribute(data.positions, 3));
		geometry.setIndex(new BufferAttribute(data.indices, 1));
		mesh = new MeshBVH(geometry, {indirect: true});
		floorIds = data.floorIds;
		points = data.points;
		tolerance = data.tolerance;
		self.postMessage({type: "ready", epoch: data.epoch});
		return;
	}

	if (data.type === "clear") {
		geometry?.dispose();
		mesh = geometry = floorIds = points = null;
		return;
	}

	ray.direction.fromArray(data.direction);
	const counts = new Float32Array(points.length / 3);
	const indices = geometry.index.array;
	for (let index = 0; index < counts.length; index++) {
		ray.origin.fromArray(points, index * 3);
		const hits = mesh.raycast(ray, DoubleSide, tolerance).sort((left, right) => left.distance - right.distance);
		let previousDistance = -Infinity;
		for (const hit of hits) {
			const floor = Math.floor(floorIds[indices[hit.faceIndex * 3]]);
			if (data.floorRange && (floor < data.floorRange[0] || floor >= data.floorRange[1])) continue;
			// Adjacent triangles and coincident surfaces count as one occluder.
			if (hit.distance - previousDistance < tolerance) continue;
			previousDistance = hit.distance;
			counts[index]++;
		}
	}
	self.postMessage({type: "result", epoch: data.epoch, counts}, [counts.buffer]);
};
