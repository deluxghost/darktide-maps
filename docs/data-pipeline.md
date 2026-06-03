# Darktide Maps Data Pipeline

This project turns `NavExporter` dumps into static web assets. The web app does
not read raw game dump JSON at runtime.

## Flow

```text
Darktide mod dump
  -> scripts/build-map-assets.mjs
  -> public/data/maps.json
  -> public/data/*.glb
  -> browser loads maps.json and the selected map assets
```

## Dump Input

`NavExporter` writes under the game-relative path:

```text
binaries/dump/NavExporter/
```

The build expects these subdirectories:

```text
navmesh/<mission>.json
main_path/<mission>.json
markers/<marker-family>/<mission>.json
metadata/missions.json
```

`missionexport` writes in-mission data: navmesh, main path, and marker families.
`tableexport` writes table metadata such as mission names and zones.

Marker families are independent directories so new marker types can be added
without changing existing dump files.

## Manual Metadata

The project also reads hand-maintained metadata:

```text
metadata/map.json
metadata/markers.json
```

`metadata/map.json` contains the accepted zone ids, zone display text, and
mission title translations keyed by exported localization keys.

`metadata/markers.json` is for manual marker overrides keyed by stable generated
marker ids. Build rules such as merge distances, default names, and id creation
belong in preprocessing code, not in this metadata file.

The build must not call private localization lookup code. Missing title text is
fixed by editing `metadata/map.json`.

## Build

Run from the project root:

```powershell
npm run build:maps -- "<game-directory>\binaries\dump\NavExporter" ".\public\data"
```

The script writes:

```text
public/data/maps.json
public/data/<mission>.glb
public/data/<mission>.main_path.glb
```

It also removes stale generated `.glb` files that are no longer referenced by
`maps.json`.

## Runtime Manifest

`maps.json` is the browser manifest. Important top-level fields:

```json
{
	"schemaVersion": 1,
	"dataUpdatedAtUnix": 1780505697,
	"zones": {},
	"maps": []
}
```

`dataUpdatedAtUnix` is a Unix timestamp in seconds from the asset build
completion time. The browser formats it as local time.

Each map entry points to its optimized assets and optional presentation metadata:

```json
{
	"id": "mission-id",
	"zone": "zone-id",
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
		"pins": []
	}
}
```

If a mission zone is not listed in `metadata/map.json`, the map omits `zone` and
the browser groups it under Other.

## Rebuild Rules

Change only frontend runtime config or translations:

```text
No map asset rebuild needed.
```

Change generated geometry, marker merge rules, marker category derivation, or
input dumps:

```text
Run npm run build:maps again.
```

Runtime values live in `APP_CONFIG.runtime`. Build-time values live in
`APP_CONFIG.build`.

## Validation

Use syntax checks for edited JavaScript modules:

```powershell
node --check .\src\app.js
node --check .\scripts\build-map-assets.mjs
```

Use the full frontend build before release:

```powershell
npm run build
```
