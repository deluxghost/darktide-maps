---
name: darktide-build-map-assets
description: "Build optimized Darktide map web assets for the darktide-maps project. Use this skill when converting NavExporter JSON dumps into web-ready map and landmark assets, refreshing maps.json, adding exported maps to the webapp, or checking generated asset size reductions."
---

# Build Darktide Map Assets

## Scope

Use the existing project script:

```text
scripts/build-map-assets.mjs
```

The script converts `navmesh/<mission>.json` dumps into standard glTF 2.0
binary `.glb` files. When `main_path/<mission>.json` exists, it also converts
that route into an optimized landmark `.glb` with embedded parts. When
`metadata/missions.json` exists, it merges mission title and zone metadata into the
manifest. It refreshes:

```text
public/data/maps.json
```

The script also removes stale generated `.glb` files that are no longer
referenced by the refreshed manifest.

The webapp loads `maps.json`, then requests only the currently selected map and
its declared landmark assets.

## Input path

`NavExporter` writes dump files under:

```text
binaries/dump/NavExporter/navmesh/
binaries/dump/NavExporter/main_path/
binaries/dump/NavExporter/metadata/
```

This is relative to the Darktide game directory. Do not write a
machine-specific absolute game installation path into this skill or project
documentation.

The build also reads the project-local hand-maintained metadata file:

```text
map-metadata.json
```

This file contains accepted zone ids with app-owned display text, plus mission
title localization values keyed by exported game localization keys. Do not add
private localization lookup code to the build script.

## Build command

From the `darktide-maps` project root, run:

```powershell
npm run build:maps -- "<game-directory>\binaries\dump\NavExporter" ".\public\data"
```

The script prints source navmesh JSON size, generated base map GLB size, and
percentage reduction for each map.

## Output

The generated web assets are:

```text
public/data/<mission>.glb
public/data/<mission>.main_path.glb
public/data/maps.json
```

Do not copy navmesh JSON dump files into `public/data/`. Keep the verbose
JSON dumps as build inputs outside the webapp. Navmesh file names must use the
exact `<mission>.json` format. Main path assets are optional and only generated
for maps that have `main_path/<mission>.json`.

Main path colors are frontend configuration, not baked into generated GLB
vertex colors. The generated `main_path` GLB embeds `tube`, `arrows`, and
`start` part ids.

Mission metadata is stored in `maps.json`. It includes mission title keys and
zone ids. A mission zone is included only when it exists in `map-metadata.json`;
maps outside that list omit `zone` and are grouped as Other by the browser.

`src/config.js` separates runtime and build-time values:

- `VISUAL_CONFIG.runtime` is applied by the browser. Color-only changes do not
  require rebuilding map assets.
- `VISUAL_CONFIG.build` changes generated geometry. Radius, side count, arrow
  overlap/offset, arrow size, sphere size, and vertical offset changes require
  `npm run build:maps`.

## Validation

Run:

```powershell
node --check .\scripts\build-map-assets.mjs
node --check .\scripts\gltf-writer.mjs
node --check .\scripts\main-path-geometry.mjs
node --check .\src\app.js
npm run build
```

Then inspect:

```powershell
Get-ChildItem -LiteralPath .\public\data -File |
  Select-Object Name,Length
```

Expected project data files are `.glb` assets and `maps.json`. Confirm that no
raw JSON dump files remain under `public/data/`.

For local development, run:

```powershell
npm run dev
```
