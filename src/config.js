export const VISUAL_CONFIG = {
	runtime: {
		view: {
			near: -10000,
			far: 10000,
			minZoom: -2,
			maxZoom: 6,
		},
		lighting: {
			navmeshMaterial: {
				ambient: 0.65,
				diffuse: 0.35,
				shininess: 16,
				specularColor: [20, 20, 20],
			},
			mainPathMaterial: {
				ambient: 0.82,
				diffuse: 0.18,
				shininess: 8,
				specularColor: [12, 12, 12],
			},
		},
		navmesh: {
			boundaryColor: [255, 255, 223, 245],
			boundaryWidth: 0.3,
		},
		mainPath: {
			tubeColor: [255, 125, 0, 255],
			arrowsColor: [255, 61, 41, 255],
			startColor: [86, 255, 131, 255],
		},
		pins: {
			iconWidth: 28,
			iconHeight: 36,
			tooltipOffset: [18, -23],
			categories: {
				chest: {
					labelKey: "markerChest",
					color: [244, 190, 76, 245],
					outlineColor: [43, 32, 12, 255],
				},
			},
		},
	},
	build: {
		mainPath: {
			verticalOffset: 1.1,
			tubeRadius: 0.5,
			tubeSides: 12,
			arrowTailOverlap: 1.2,
			arrowTipOffset: 2.1,
			arrowRadius: 1.25,
			arrowSides: 12,
			startSphereRadius: 1.5,
			sphereLatitudes: 8,
			sphereLongitudes: 12,
		},
	},
};
