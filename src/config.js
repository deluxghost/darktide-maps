export const APP_CONFIG = {
	ui: {
		mobileMediaQuery: "(max-width: 640px)",
		trailingZoneIds: ["operations", "other"],
	},
	runtime: {
		view: {
			near: -1000,
			far: 1000,
			minZoom: -2,
			maxZoom: 6,
			initialRotationX: 55,
			initialViewPadding: 0.8,
			minRotationX: 5,
			maxRotationX: 90,
			minWorldSize: 1,
		},
		controls: {
			dragMode: "pan",
			touchRotate: true,
			orbitAxis: "Z",
			orthographic: true,
		},
		layers: {
			opaqueMeshParameters: {
				blend: false,
				depthCompare: "less-equal",
				depthMask: true,
				depthTest: true,
				depthWriteEnabled: true,
				polygonOffsetFill: false,
			},
			screenMarkerParameters: {
				blend: true,
				depthMask: false,
				depthTest: false,
				depthWriteEnabled: false,
			},
			iconTextureParameters: {
				minFilter: "linear",
				magFilter: "linear",
				mipmapFilter: "none",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		},
		visual: {
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
				heightColors: [
					[94, 132, 185],
					[73, 154, 196],
					[66, 177, 184],
					[78, 190, 151],
					[132, 201, 111],
					[190, 211, 93],
					[226, 214, 100],
				],
				boundaryColor: [255, 255, 223, 245],
				boundaryWidth: 0.3,
				boundaryDepthBias: -1,
				boundaryDepthBiasSlopeScale: -1,
			},
			mainPath: {
				tubeColor: [255, 125, 0, 255],
				arrowsColor: [255, 61, 41, 255],
				startColor: [86, 255, 131, 255],
			},
			pins: {
				iconWidth: 28,
				iconHeight: 36,
				iconTextureScale: 3,
				tooltipOffset: [18, -23],
				categories: {
					chest: {
						labelKey: "markerChest",
						color: [244, 190, 76, 245],
						outlineColor: [43, 32, 12, 255],
					},
					health_station: {
						labelKey: "markerHealthStation",
						color: [96, 226, 132, 245],
						outlineColor: [14, 54, 30, 255],
					},
					respawn_point: {
						labelKey: "markerRespawnPoint",
						color: [92, 190, 255, 245],
						outlineColor: [13, 37, 64, 255],
					},
					supply_spawn: {
						labelKey: "markerSupplySpawn",
						color: [220, 220, 235, 245],
						outlineColor: [45, 45, 58, 255],
					},
					side_mission_spawn: {
						labelKey: "markerSideMissionSpawn",
						color: [184, 124, 255, 245],
						outlineColor: [42, 23, 66, 255],
					},
					boss_spawn: {
						labelKey: "markerBossSpawn",
						color: [255, 92, 75, 245],
						outlineColor: [74, 20, 15, 255],
					},
					daemonhost: {
						labelKey: "markerDaemonhost",
						color: [210, 86, 255, 245],
						outlineColor: [54, 12, 68, 255],
					},
					havoc_boss_spawn: {
						labelKey: "markerHavocBossSpawn",
						color: [255, 128, 96, 245],
						outlineColor: [76, 28, 18, 255],
					},
				},
			},
		},
	},
	processing: {
		boundaries: {
			coordinatePrecision: 4,
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
		markers: {
			chestMergeHorizontalDistance: 2,
			chestMergeVerticalDistance: 1,
			respawnPointMergeHorizontalDistance: 8,
			respawnPointMergeVerticalDistance: 2,
			supplyDistributions: ["primary", "secondary", "mid_event", "end_event"],
		},
	},
};
