import config from "../../../config/build.json" with {type: "json"};

export const BUILD_CONFIG = config;

export function shouldOmitMainPath(missionId) {
	return config.omit.byMission[missionId]?.mainPath === true;
}
