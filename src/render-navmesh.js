import { COORDINATE_SYSTEM, Deck, OrbitView } from "@deck.gl/core";
import { PathLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";

const BOUNDARY_COLOR = [255, 255, 223, 245];
const BOUNDARY_WIDTH = 0.3;

function midpoint(min, max) {
	return [
		(min[0] + max[0]) / 2,
		(min[1] + max[1]) / 2,
		(min[2] + max[2]) / 2,
	];
}

function initialZoom(bounds) {
	const width = Math.max(bounds.max[0] - bounds.min[0], 1);
	const height = Math.max(bounds.max[1] - bounds.min[1], 1);
	const scale = Math.min(window.innerWidth / width, window.innerHeight / height);

	return Math.log2(scale) - 1;
}

export function createNavmeshRenderer(mapElement, onError) {
	let deckInstance;

	return (map, mesh, boundaryPaths) => {
		const viewState = {
			target: midpoint(map.bounds.min, map.bounds.max),
			rotationOrbit: 0,
			rotationX: 55,
			minRotationX: 5,
			maxRotationX: 90,
			zoom: initialZoom(map.bounds),
		};
		const surfaceLayer = new SimpleMeshLayer({
			id: `navmesh-surface-${map.id}`,
			data: [{}],
			mesh,
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			getPosition: [0, 0, 0],
			getColor: [255, 255, 255, 255],
			wireframe: false,
			material: false,
		});
		const boundaryLayer = new PathLayer({
			id: `navmesh-boundaries-${map.id}`,
			data: boundaryPaths,
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			getPath: (boundary) => boundary.path,
			getColor: BOUNDARY_COLOR,
			getWidth: BOUNDARY_WIDTH,
			widthUnits: "common",
			jointRounded: true,
			capRounded: true,
		});
		const layers = [surfaceLayer, boundaryLayer];

		if (deckInstance) {
			deckInstance.setProps({
				initialViewState: viewState,
				layers,
			});

			return;
		}

		deckInstance = new Deck({
			parent: mapElement,
			views: new OrbitView({
				id: "navmesh",
				controller: {
					dragMode: "pan",
					touchRotate: true,
				},
				orbitAxis: "Z",
				orthographic: true,
			}),
			initialViewState: viewState,
			layers,
			onError,
		});
	};
}
