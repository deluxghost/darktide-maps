import { LayerExtension } from "@deck.gl/core";
import { APP_CONFIG } from "../config.js";

const patternModule = {
	name: "unreachablePattern",
	fs: `
uniform unreachablePatternUniforms {
	float spacing;
	float width;
	float opacity;
} unreachablePattern;
flat in float unreachableSurface;
flat in float patternPixelRatio;
`,
	uniformTypes: {spacing: "f32", width: "f32", opacity: "f32"},
	inject: {
		"fs:DECKGL_FILTER_COLOR": {
			order: 10,
			injection: `
	if (unreachableSurface > 0.5) {
		float coordinate = dot(gl_FragCoord.xy / patternPixelRatio, vec2(0.70710678));
		float distance = abs(mod(coordinate, unreachablePattern.spacing) - unreachablePattern.spacing * 0.5);
		float antialias = fwidth(coordinate) * 0.5;
		float line = 1.0 - smoothstep(unreachablePattern.width * 0.5 - antialias,
			unreachablePattern.width * 0.5 + antialias, distance);
		color.rgb *= 1.0 - line * unreachablePattern.opacity;
	}
`,
		},
	},
};

export class UnreachablePatternExtension extends LayerExtension {
	static extensionName = "UnreachablePatternExtension";

	getShaders() {
		return {
			modules: [patternModule],
			inject: {
				"vs:#decl": "flat out float unreachableSurface;\nflat out float patternPixelRatio;",
				"vs:DECKGL_FILTER_GL_POSITION": "unreachableSurface = geometry.uv.y;\npatternPixelRatio = project.devicePixelRatio;",
			},
		};
	}

	draw() {
		this.setShaderModuleProps({unreachablePattern: APP_CONFIG.runtime.visual.navmesh.unreachablePattern});
	}
}
