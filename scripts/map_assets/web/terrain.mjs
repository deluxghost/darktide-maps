export function validateTerrain(packet) {
	const surface = packet.terrain;
	if (surface.mission !== packet.id || !surface.data.complete
		|| surface.stats.inputTriangles !== packet.navmesh.triangles.length
		|| surface.navmesh.triangles.length !== surface.stats.outputTriangles) {
		throw new Error(`Incomplete terrain stage: ${packet.id}`);
	}
	const mesh = surface.removedMesh;
	if (mesh.positions.length !== mesh.normals.length || mesh.positions.length !== mesh.indices.length * 3
		|| mesh.positions.some(value => !Number.isFinite(value))) {
		throw new Error(`Invalid terrain diagnostic geometry: ${packet.id}`);
	}
	return surface;
}
