# Darktide Maps Data Pipeline

## Runtime dump layout

`NavExporter` owns its directory under the game-relative dump path:

```text
binaries/dump/NavExporter/
```

Implemented runtime output:

```text
binaries/dump/NavExporter/navmesh/<mission>.json
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
```

It writes:

```text
public/data/<mission>.glb
public/data/maps.json
```

Generated `.glb` files that are no longer referenced by the refreshed manifest
are removed.

## Web manifest extension points

The current manifest requires `maps`. The UI also accepts optional presentation
metadata without requiring changes to navmesh assets:

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
			"file": "./data/mission-id.glb"
		}
	]
}
```

`regionId` and `regions` are optional. Until metadata export and preprocessing
are implemented, the UI lists mission ids without region grouping.

Marker category filters have a reserved HUD region. Marker schemas and filter
behavior must be implemented together after marker data sources are confirmed.
