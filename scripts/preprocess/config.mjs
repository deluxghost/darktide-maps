export const PREPROCESS_CONFIG = {
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
	view: {
		fitGridSize: 96,
	},
	omit: {
		byMission: {
			km_enforcer_twins: {
				markerCategories: ["boss_spawn", "daemonhost", "side_mission_spawn"],
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
