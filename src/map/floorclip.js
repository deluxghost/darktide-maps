import { LayerExtension } from "@deck.gl/core";

export function floorCoordinatesAttribute(floors) {
	const values = new Float32Array(floors.length * 2);
	for (let index = 0; index < floors.length; index++) values[index * 2] = floors[index];
	// SimpleMeshLayer preserves UV attributes but removes custom geometry attributes.
	return {size: 2, value: values};
}

const floorClipModule = {
	name: "floorClip",
	fs: `
uniform floorClipUniforms {
	float enabled;
	vec2 range;
} floorClip;
in float floorCoordinate;
`,
	uniformTypes: { enabled: "f32", range: "vec2<f32>" },
	inject: {
		"fs:DECKGL_FILTER_COLOR": {
			order: 1,
			injection: `
	if (floorClip.enabled > 0.5 && (floorCoordinate < floorClip.range.x || floorCoordinate >= floorClip.range.y)) {
		discard;
	}
`,
		},
	},
};

export class FloorClipExtension extends LayerExtension {
	static extensionName = "FloorClipExtension";
	static defaultProps = {
		floorRange: { type: "array", value: null, compare: true, optional: true },
		getFloorId: { type: "accessor", value: (path) => path.floorIndex + 0.5 },
	};

	getShaders(extension) {
		const path = extension.opts?.path;
		return {
			modules: [floorClipModule],
			inject: {
				"vs:#decl": `${path ? "in float instanceFloorIds;" : ""}\nout float floorCoordinate;`,
				"vs:DECKGL_FILTER_GL_POSITION": `floorCoordinate = ${path ? "instanceFloorIds" : "geometry.uv.x"};`,
			},
		};
	}

	initializeState(context, extension) {
		if (extension.opts?.path) {
			this.getAttributeManager().addInstanced({
				instanceFloorIds: { size: 1, accessor: "getFloorId" },
			});
		}
	}

	draw() {
		const range = this.props.floorRange;
		this.setShaderModuleProps({
			floorClip: { enabled: range ? 1 : 0, range: range ?? [0, 0] },
		});
	}
}
