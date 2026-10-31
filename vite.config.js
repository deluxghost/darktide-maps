import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import {validateMarkerConfiguration} from "./scripts/map_assets/web/marker_overrides.mjs";
import manifest from "./public/data/maps.json" with {type: "json"};

validateMarkerConfiguration(manifest.maps.map((map) => map.id));

export default defineConfig({
	plugins: [cloudflare()],
	server: {watch: {ignored: [/[\\/]public[\\/]data(?:\.[^\\/]*)?(?:[\\/]|$)/]}},
});
