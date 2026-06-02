import { Geometry } from "@luma.gl/engine";

export function createLandmarkMesh(glb) {
	if (!glb.normals) {
		throw new Error("Landmark GLB is missing normals.");
	}

	return new Geometry({
		topology: "triangle-list",
		attributes: {
			positions: { size: 3, value: glb.positions },
			normals: { size: 3, value: glb.normals },
		},
		indices: glb.indices,
	});
}
