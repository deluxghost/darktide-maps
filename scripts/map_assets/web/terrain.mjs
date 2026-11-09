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

export function validateReach(packet) {
	const reach = packet.reach;
	const shown = reach?.shownTriangles;
	const count = packet.terrain.navmesh.triangles.length;
	if (!Array.isArray(shown) || shown.length === 0
		|| shown.some((index, at) => !Number.isInteger(index) || index < 0 || index >= count || (at && index <= shown[at - 1]))
		|| (!reach.evaluated && shown.length !== count)) {
		throw new Error(`Incomplete reachability stage: ${packet.id}`);
	}
	return reach;
}
