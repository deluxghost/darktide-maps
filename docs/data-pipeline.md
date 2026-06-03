# Darktide Maps Data Pipeline

## Runtime dump layout

`NavExporter` owns its directory under the game-relative dump path:

```text
binaries/dump/NavExporter/
```

Implemented runtime output:

```text
binaries/dump/NavExporter/navmesh/<mission>.json
binaries/dump/NavExporter/main_path/<mission>.json
binaries/dump/NavExporter/markers/chests/<mission>.json
binaries/dump/NavExporter/markers/health_stations/<mission>.json
binaries/dump/NavExporter/markers/respawn_points/<mission>.json
binaries/dump/NavExporter/markers/pickups/<mission>.json
binaries/dump/NavExporter/markers/boss_spawns/<mission>.json
binaries/dump/NavExporter/markers/daemonhosts/<mission>.json
binaries/dump/NavExporter/markers/havoc_boss_spawns/<mission>.json
binaries/dump/NavExporter/metadata/missions.json
```

`missionexport` writes the active-mission files: navmesh, main path, and
marker dumps. `tableexport` writes table-based metadata and does not require
entering a mission.

Reserved directory families:

```text
binaries/dump/NavExporter/markers/<marker-family>/
```

Marker families are independent so later marker types can be added without
changing existing exports.

## Web asset build

Run:

```powershell
npm run build:maps -- "<game-directory>\binaries\dump\NavExporter" ".\public\data"
```

The build reads:

```text
navmesh/<mission>.json
main_path/<mission>.json
markers/<marker-family>/<mission>.json
metadata/missions.json
<project>/metadata/map.json
<project>/metadata/markers.json
```

`metadata/missions.json` is optional for old dump sets. When present, it adds
mission title keys and zone ids to the web manifest. A mission zone is included
only when it exists in `metadata/map.json`; maps outside that list omit `zone`
and are grouped as Other by the browser.

`metadata/map.json` is a hand-maintained project metadata file. It contains
accepted zone ids with app-owned display text, plus mission title localization
values keyed by the exported game localization keys. The build does not call
private localization lookup code.

`metadata/markers.json` is the hand-maintained marker metadata file. It contains
optional overrides keyed by stable generated marker ids. Build rules such as
default names, merge distances, and id generation live in the preprocessing
code, not in manual metadata.

It writes:

```text
public/data/<mission>.glb
public/data/<mission>.main_path.glb
public/data/maps.json
```

`main_path` is optional per mission. When present, the build converts it into a
render-ready GLB containing embedded `tube`, `arrows`, and `start` parts. The
browser loads this optimized landmark asset instead of generating route geometry
from raw JSON at runtime. Landmark colors are applied by the frontend visual
config, not baked into the generated GLB.

Marker dumps are optional per mission. Each dump contains one pin per exported
source location and only includes fields consumed by the build: `mission`,
`pins`, `position`, `source`, and optional `name_key` for pins whose display
name differs from their category label. When present, the build embeds marker
pins into `maps.json` under the map entry's `markers.pins` field. Pin category
colors and labels are frontend configuration.

Pickup spawner data is dumped as one family under `markers/pickups`. The dump
keeps each component's `distribution_type`; the build derives current UI marker
categories from that single source. `primary`, `secondary`, `mid_event`, and
`end_event` become supply spawn pins. `side_mission` becomes side mission spawn
pins. Other pickup distributions remain in the raw dump for later analysis and
future marker categories.

Marker ids are generated from the mission id plus stable source identifiers
exported by the mod. The mission id is part of the generated id because some
maps reuse source ids across missions. Chest pins may be merged when very close
units represent one visible chest pile; the merged id is generated from the
sorted member source ids. A marker dump without `source` is invalid.

Generated `.glb` files that are no longer referenced by the refreshed manifest
are removed.

## Project config

Project configuration lives in `src/config.js` under `APP_CONFIG`. The main
sections are:

```text
APP_CONFIG.ui
APP_CONFIG.runtime
APP_CONFIG.processing
APP_CONFIG.build
```

`ui` values control browser UI behavior such as the mobile media query and
zone ordering. `runtime` values are applied by the browser, including camera
limits, controls, layer parameters, colors, lighting, and pin category styles.

`processing` values affect runtime data processing, such as navmesh boundary
coordinate precision. `build` values affect generated assets and marker
preprocessing, such as main path geometry, marker merge distances, and pickup
distribution classification. Changing `build` values requires rerunning
`npm run build:maps`.

## Web manifest extension points

The current manifest requires `maps`. The UI also accepts optional presentation
metadata without requiring changes to generated base map assets:

```json
{
	"schemaVersion": 1,
	"zones": {
		"zone-id": {
			"en": "Zone title"
		}
	},
	"maps": [
		{
			"id": "mission-id",
			"zone": "zone-id",
			"titleKey": "loc_mission_name",
			"title": {
				"en": "Mission title"
			},
			"file": "./data/mission-id.glb",
			"landmarks": {
				"mainPath": {
					"file": "./data/mission-id.main_path.glb"
				}
			},
			"markers": {
				"pins": [
					{
						"id": "chest_1a2b3c4d5e6f",
						"category": "chest",
						"name": {
							"key": "markerChestStack",
							"values": {
								"count": 3
							}
						},
						"position": [0, 0, 0]
					}
				]
			}
		}
	]
}
```

`zone` and `zones` are optional. Without metadata input, the UI lists mission ids
under `other`.

Marker category filters use frontend runtime configuration in `src/config.js`.
