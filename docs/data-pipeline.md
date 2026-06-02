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
binaries/dump/NavExporter/metadata/missions.json
```

Navmesh and main path exports require an active mission. Table-based metadata
does not require entering a mission and is exported by the `maptableexport`
command.

Reserved directory families:

```text
binaries/dump/NavExporter/markers/
```

These directories describe ownership boundaries only. Their exporters and
schemas must be based on confirmed game data sources before implementation.

## Web asset build

Run:

```powershell
npm run build:maps -- "<game-directory>\binaries\dump\NavExporter" ".\public\data"
```

The build reads:

```text
navmesh/<mission>.json
main_path/<mission>.json
metadata/missions.json
<project>/map-metadata.json
```

`metadata/missions.json` is optional for old dump sets. When present, it adds
mission title keys and zone ids to the web manifest. A mission zone is included
only when it exists in `map-metadata.json`; maps outside that list omit `zone`
and are grouped as Other by the browser.

`map-metadata.json` is a hand-maintained project metadata file. It contains
accepted zone ids with app-owned display text, plus mission title localization
values keyed by the exported game localization keys. The build does not call
private localization lookup code.

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
			}
		}
	]
}
```

`zone` and `zones` are optional. Without metadata input, the UI lists mission ids
under `other`.

Marker category filters have a reserved HUD area. Marker schemas and filter
behavior must be implemented together after marker data sources are confirmed.
