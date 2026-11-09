// Both views share one navmesh; reachable triangles form an index prefix.
// Meshes, markers and boundaries carry separate layer assignments for each view.

export function isReachableView(map, showUnreachable) {
	return map.reach.evaluated && !showUnreachable;
}

export function viewFloors(glb, reachable) {
	return {...glb, floorIds: reachable ? glb.reachFloorIds : glb.floorIds};
}

export function navmeshView(glb, map, reachable) {
	return {
		...viewFloors(glb, reachable),
		indices: reachable ? glb.indices.subarray(0, map.reach.shownTriangles * 3) : glb.indices,
	};
}

export function viewLayers(map, reachable) {
	return reachable ? map.floorSlices.reachLayers : map.floorSlices.layers;
}

export function viewPins(pins, reachable) {
	return reachable ? pins.map((pin) => ({...pin, floorIndex: pin.reachFloorIndex})) : pins;
}
