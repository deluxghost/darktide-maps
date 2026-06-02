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
```

Navmesh export is mission-bound and slow. Keep other data families separate so
they can use independent commands and do not repeat navmesh extraction.

Reserved directory families:

```text
binaries/dump/NavExporter/metadata/
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
```

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
	"regions": [
		{
			"id": "region-id",
			"title": "Region title"
		}
	],
	"maps": [
		{
			"id": "mission-id",
			"regionId": "region-id",
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

`regionId` and `regions` are optional. Until metadata export and preprocessing
are implemented, the UI lists mission ids without region grouping.

Marker category filters have a reserved HUD region. Marker schemas and filter
behavior must be implemented together after marker data sources are confirmed.
