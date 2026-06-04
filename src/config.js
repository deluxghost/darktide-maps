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
			joystickOrbitDegreesPerFrame: 1.2,
			joystickPitchDegreesPerFrame: 0.8,
			touchRotate: false,
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
			relations: {
				arcDistanceRatio: 0.38,
				arcMaxTiltDegrees: 35,
				arcWidth: 3,
				arcOutlineWidth: 2.6,
				arrowPadding: 7,
				arrowHeadLength: 14,
				arrowHeadWidth: 10,
				triggerPinScale: 0.65,
				triggerPinStrokeWidth: 1.9,
				tooltipOffset: [7, 0],
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
					},
					health_station: {
						labelKey: "markerHealthStation",
						color: [96, 226, 132, 245],
					},
					respawn_point: {
						labelKey: "markerRespawnPoint",
						color: [92, 190, 255, 245],
					},
					supply_spawn: {
						labelKey: "markerSupplySpawn",
						color: [189, 163, 132, 245],
					},
					side_mission_spawn: {
						labelKey: "markerSideMissionSpawn",
						color: [154, 132, 188, 245],
					},
					boss_spawn: {
						labelKey: "markerBossSpawn",
						color: [255, 92, 75, 245],
					},
					daemonhost: {
						labelKey: "markerDaemonhostSpawn",
						color: [210, 86, 255, 245],
					},
					havoc_boss_spawn: {
						labelKey: "markerHavocBossSpawn",
						color: [255, 128, 96, 245],
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
};
