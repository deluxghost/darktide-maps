export const FLOOR_CASES = {
	sameFloor: [
		{
			name: "dm_propaganda high platform is not claimed by the far upper floor",
			mapId: "dm_propaganda",
			points: [
				[-41.089, 186.811, 37.405],
				[-40.786, 188.755, 37.509],
				[-40.443, 187.256, 37.418],
			],
		},
		{
			name: "dm_propaganda mid platform is not claimed by the far upper floor",
			mapId: "dm_propaganda",
			points: [
				[7.586, -8.662, 12.355],
			],
		},
		{
			name: "dm_propaganda small flat areas stay together",
			mapId: "dm_propaganda",
			points: [
				[-16.535, 41.586, 8.381],
				[-13.556, 38.491, 8.384],
				[18.942, 40.852, 7.506],
				[22.822, 48.365, 7.374],
				[-25.39, 3.617, 8.337],
				[-22.11, 4.144, 8.341],
			],
		},
		{
			name: "dm_propaganda low edge samples stay together",
			mapId: "dm_propaganda",
			points: [
				[-213.76, 62.544, 2.88],
				[-194.665, 40.383, 2.886],
			],
		},
		{
			name: "km_heresy flat sample cluster",
			mapId: "km_heresy",
			points: [
				[-78.46, -142.578, -6.326],
				[-76.362, -127.376, -6.273],
				[-71.579, -135.337, -6.555],
				[-72.52, -136.327, -6.577],
				[-76.639, -145.017, -6.287],
				[-74.612, -143.538, -6.371],
			],
		},
		{
			name: "hm_cartel flat sample cluster",
			mapId: "hm_cartel",
			points: [
				[12.002, 48.422, 10.544],
				[-8.809, 58.652, 10.497],
				[-17.978, 70.179, 10.458],
				[-14.762, 72.613, 10.43],
			],
		},
		{
			name: "km_enforcer channel and bump remain on the lower floor",
			mapId: "km_enforcer",
			points: [
				[222.607, -180.747, 2.196],
				[218.676, -179.767, 3.536],
				[227.126, -179.593, 3.483],
				[236.959, -47.099, 3.288],
			],
		},
		{
			name: "dm_propaganda trench edge remains with the nearby lower trench",
			mapId: "dm_propaganda",
			points: [
				[-249.779, 82.794, 2.775],
				[-246.023, 71.925, 0.503],
				[-241.871, 53.766, 2.803],
			],
		},
		{
			name: "lm_scavenge continuous one-way slope stays together",
			mapId: "lm_scavenge",
			points: [
				[-54.704, -51.512, -143.881],
				[-48.986, -40.264, -146.583],
			],
		},
	],
	differentFloor: [
		{
			name: "dm_propaganda high platform stays below the remote upper platform",
			mapId: "dm_propaganda",
			points: [
				[-41.089, 186.811, 37.405],
				[-270.437, 124.949, 56.525],
			],
		},
		{
			name: "dm_propaganda mid platform stays below the remote upper platform",
			mapId: "dm_propaganda",
			points: [
				[7.586, -8.662, 12.355],
				[1.014, 141.528, 31.409],
			],
		},
		{
			name: "psykhanium stacked spawn samples remain split",
			mapId: "psykhanium",
			pairs: [
				[
					[18.276, 354.19, -1.619],
					[19.234, 352.789, 2.937],
				],
				[
					[47.232, 416.559, -3.487],
					[48.571, 413.57, 2.442],
				],
			],
		},
	],
};
