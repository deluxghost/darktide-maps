export const PREPROCESS_CONFIG = {
	mainPath: {
		verticalOffset: 1.1,
		tubeRadius: 0.5,
		tubeSides: 12,
		segmentConnectorDashLength: 4,
		segmentConnectorGapLength: 3,
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
	view: {
		fitGridSize: 96,
	},
	boundaries: {
		coordinatePrecision: 4,
		minimumCollapsedArea: 0.05,
		maximumDanglingBranchLength: 3.5,
	},
	blockedEdges: {
		verticalOffset: 0.16,
		polygons: {
			closeRadiusCells: 2,
			mergeDistanceCells: 4,
			mergeVerticalDistance: 1.5,
			simplifyToleranceCells: 0.75,
			minimumArea: 0.5,
			minimumSecondaryAreaRatio: 0.2,
		},
		navmeshCarve: {
			verticalDistance: 1.5,
			minimumFragmentArea: 0.8,
		},
		manualExcludes: {
			verticalTolerance: 1.5,
			byMission: {
				dm_rise: [
					[1.053, -37.092, -23.075],
					[-21.44, -60.436, -22.995],
				],
				fm_cargo: [
					[-101.873, -319.484, -24.873],
				],
				hm_strain: [
					[-66.576, 75.924, -106.729],
				],
				hub_ship: [
					[2.111, -129.354, 100.649],
					[-2.308, -129.245, 100.66],
				],
				km_enforcer_twins: [
					[195.445, -63.743, -3.213],
					[50.815, -64.03, 12.189],
					[-26.363, -56.282, 14.669],
					[-40.493, -60.641, 14.656],
					[-39.694, -64.139, 14.666],
				],
				km_heresy: [
					[-62.768, -9.839, -19.408],
				],
				km_station: [
					[44.813, -129.929, -1.088],
				],
				lm_rails: [
					[-249.626, 331.076, -61.854],
					[-240.547, 326.257, -61.866],
					[-233.122, 322.552, -61.87],
					[-198.936, 384.461, -66.192],
				],
				op_no_mans_land: [
					[-128.172, 37.303, -4.369],
					[-81.486, 422.983, -3.743],
				],
				op_train: [
					[-0.149, -81.372, 1.068],
					[7.934, -72.995, 0.702],
					[-5.726, -73.87, 0.584],
					[0.178, -247.223, 0.568],
				],
				psykhanium: [
					[378.114, -237.167, 8.867],
				],
			},
		},
		markerCollisionFilter: {
			families: ["chests", "health_stations", "respawn_points"],
			distance: 2,
		},
	},
	omit: {
		byMission: {
			km_enforcer_twins: {
				markerCategories: ["boss_spawn", "daemonhost", "scripture_spawn", "grimoire_spawn"],
			},
			psykhanium: {
				mainPath: true,
			},
			tg_shooting_range: {
				mainPath: true,
			},
		},
	},
};

export function missionOmitConfig(missionId) {
	return PREPROCESS_CONFIG.omit.byMission[missionId] ?? {};
}

export function shouldOmitMainPath(missionId) {
	return missionOmitConfig(missionId).mainPath === true;
}

export function shouldOmitMarkerCategory(missionId, category) {
	return (missionOmitConfig(missionId).markerCategories ?? []).includes(category);
}
