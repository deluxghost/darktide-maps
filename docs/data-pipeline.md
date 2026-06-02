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
markers/chests/<mission>.json
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

`markers/chests` is optional per mission. The dump contains one pin per chest
unit and only includes fields consumed by the build: `mission`, `pins`,
`position`, and `source.unit_id`. When present, the build may merge very close
chest units into one display pin, then embeds marker pins into `maps.json`
under the map entry's `markers.pins` field. Pin category colors and labels are
frontend configuration.

Chest marker ids are generated from the mission id plus stable source
identifiers exported by the mod: `source.unit_id`. The mission id is part of the
generated id because some maps reuse unit ids across missions. A merged chest
marker id is generated from the sorted member source ids. Other marker families
may use different id strategies when their source data requires it. A chest dump
without `source.unit_id` is invalid.

Generated `.glb` files that are no longer referenced by the refreshed manifest
are removed.

## Visual config

Visual values live in `src/config.js` and are split by when they take
effect:

```text
VISUAL_CONFIG.runtime
VISUAL_CONFIG.build
```

`runtime` values are applied by the browser. Changing map boundary colors or
main path part colors only requires a frontend refresh.

`build` values affect generated geometry, such as main path tube radius, segment
side counts, arrow overlap/offset, arrow size, start sphere size, and vertical
offset. Changing these requires rerunning `npm run build:maps`.

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
