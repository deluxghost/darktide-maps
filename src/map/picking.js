import { LayerExtension } from "@deck.gl/core";

const packedDepthModule = {
	name: "packedDepth",
	fs: `uniform packedDepthUniforms { float enabled; } packedDepth;`,
	uniformTypes: {enabled: "f32"},
	defaultUniforms: {enabled: 0},
	inject: {
		"fs:DECKGL_FILTER_COLOR": {
			// Run after deck.gl's picking filter, which supplies the depth in color.r.
			order: 100,
			injection: `
	if (packedDepth.enabled > 0.5) {
		// Reserve all-zero bytes for empty pixels without quantizing the depth.
		highp uint bits = floatBitsToUint(color.r) + 1u;
		color = vec4(float(bits & 255u), float((bits >> 8u) & 255u),
			float((bits >> 16u) & 255u), float(bits >> 24u)) / 255.0;
	}
`,
		},
	},
};

export class NavmeshDepthExtension extends LayerExtension {
	static extensionName = "NavmeshDepthExtension";
	getShaders() { return {modules: [packedDepthModule]}; }
	draw({shaderModuleProps}) {
		// Shader inputs persist between passes; ordinary drawing must disable encoding.
		this.setShaderModuleProps({packedDepth: {enabled: shaderModuleProps.packedDepth?.enabled ?? 0}});
	}
}

function readDepthPixels(deck, picker, layerIds, rectangle) {
	const options = {
		layers: deck.layerManager.getLayers({layerIds}),
		views: deck.viewManager.getViews(),
		viewports: deck.getViewports(),
		onViewportActive: deck.layerManager.activateViewport,
		effects: deck.effectManager.getEffects(),
		pickingFBO: picker.pickingFBO,
		deviceRect: rectangle,
		pass: "picking:query:packed-depth",
		pickZ: true,
		isPicking: true,
		preRenderStats: {},
		shaderModuleProps: {packedDepth: {enabled: 1}},
	};
	for (const effect of options.effects) {
		if (effect.useInPicking) options.preRenderStats[effect.id] = effect.preRender(options);
	}
	return deck.device.withParametersWebGL({dither: false}, () => {
		picker.pickLayersPass.render(options);
		return deck.device.readPixelsToArrayWebGL(picker.pickingFBO, {
			sourceX: rectangle.x, sourceY: rectangle.y, sourceWidth: rectangle.width, sourceHeight: rectangle.height,
			target: new Uint8Array(rectangle.width * rectangle.height * 4),
		});
	});
}

export function pickNavmeshCoordinates(deck, pixels, layerIds) {
	// deck.gl's public picker reads one depth per pass. Keep batch-pass access isolated here.
	const picker = deck.deckPicker;
	picker._resizeBuffer();
	const context = deck.device.canvasContext;
	const devicePixels = pixels.map((pixel) => {
		const range = context.cssToDevicePixels(pixel, true);
		return {x: range.x + Math.floor(range.width / 2), y: range.y + Math.floor(range.height / 2)};
	});
	const inside = ({x, y}) => x >= 0 && y >= 0 && x < picker.pickingFBO.width && y < picker.pickingFBO.height;
	const valid = devicePixels.filter(inside);
	if (!valid.length) return pixels.map(() => null);
	const left = Math.min(...valid.map((pixel) => pixel.x)), right = Math.max(...valid.map((pixel) => pixel.x));
	const bottom = Math.min(...valid.map((pixel) => pixel.y)), top = Math.max(...valid.map((pixel) => pixel.y));
	const rectangle = {x: left, y: bottom, width: right - left + 1, height: top - bottom + 1};
	const colors = readDepthPixels(deck, picker, layerIds, rectangle);
	const packed = new DataView(colors.buffer, colors.byteOffset, colors.byteLength);
	const depth = new DataView(new ArrayBuffer(4));
	const viewport = deck.getViewports()[0];
	return devicePixels.map((pixel, index) => {
		if (!inside(pixel)) return null;
		const offset = ((pixel.y - bottom) * rectangle.width + pixel.x - left) * 4;
		const bits = packed.getUint32(offset, true);
		if (bits === 0) return null;
		depth.setUint32(0, bits - 1, true);
		return viewport.unproject([pixels[index][0] - viewport.x, pixels[index][1] - viewport.y, depth.getFloat32(0, true)]);
	});
}
