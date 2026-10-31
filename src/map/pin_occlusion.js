import {LayerExtension} from "@deck.gl/core";
import {APP_CONFIG} from "../config.js";

const VISUAL = APP_CONFIG.runtime.visual.pins;

export class PinOcclusionExtension extends LayerExtension {
	static extensionName = "PinOcclusionExtension";
	static defaultProps = {getPinBrightness: {type: "accessor", value: 1}};

	getShaders() {
		return {inject: {
			"vs:#decl": "in float instancePinBrightness;\nout float pinBrightness;",
			"vs:DECKGL_FILTER_GL_POSITION": "pinBrightness = instancePinBrightness;",
			"fs:#decl": "in float pinBrightness;",
			"fs:DECKGL_FILTER_COLOR": {order: 98, injection: "color.rgb *= pinBrightness;"},
		}};
	}

	initializeState() {
		this.getAttributeManager().addInstanced({
			instancePinBrightness: {size: 1, accessor: "getPinBrightness"},
		});
	}
}

export function createPinOcclusion(onChange, onError) {
	const worker = new Worker(new URL("./pin_occlusion.worker.js", import.meta.url), {type: "module"});
	let epoch = 0;
	let ready = false;
	let busy = false;
	let pending;
	let viewKey;
	let indices = new Map();
	let brightness = new Float32Array();
	let targets = new Float32Array();
	let frame = 0;
	let previousTime;
	let revision = 0;

	function dispatch() {
		if (!ready || busy || !pending) return;
		busy = true;
		worker.postMessage({type: "query", epoch, ...pending});
		pending = null;
	}

	function animate(time) {
		frame = 0;
		const step = (time - previousTime) / VISUAL.occlusionTransitionMs * (1 - VISUAL.occludedBrightness);
		previousTime = time;
		let moving = false;
		for (let index = 0; index < brightness.length; index++) {
			const delta = targets[index] - brightness[index];
			brightness[index] = Math.abs(delta) <= step ? targets[index] : brightness[index] + Math.sign(delta) * step;
			moving ||= brightness[index] !== targets[index];
		}
		revision++;
		onChange();
		if (moving) frame = requestAnimationFrame(animate);
	}

	worker.onerror = (event) => onError(new Error(`Pin occlusion worker: ${event.message}`));
	worker.onmessage = ({data}) => {
		if (data.epoch !== epoch) return;
		if (data.type === "ready") {
			ready = true;
		} else {
			busy = false;
			targets = data.counts.map((count) => VISUAL.occludedBrightness
				+ (1 - VISUAL.occludedBrightness) * (1 - VISUAL.occlusionLayerOpacity) ** count);
			if (!frame) {
				previousTime = performance.now();
				frame = requestAnimationFrame(animate);
			}
		}
		dispatch();
	};

	function clear() {
		epoch++;
		cancelAnimationFrame(frame);
		frame = 0;
		ready = busy = false;
		pending = viewKey = null;
		indices.clear();
		brightness = targets = new Float32Array();
		worker.postMessage({type: "clear"});
	}

	return {
		clear,
		setMap(glb, pins) {
			clear();
			const allPins = pins.flatMap((pin) => pin.markerType === "position_marker" ? [] : [pin, ...(pin.auxiliaryMarkers ?? [])]);
			indices = new Map(allPins.map((pin, index) => [pin.id, index]));
			brightness = new Float32Array(allPins.length).fill(1);
			targets = brightness.slice();
			const positions = glb.positions.slice();
			const triangles = glb.indices.slice();
			const floors = glb.floorIds.slice();
			const points = new Float32Array(allPins.flatMap((pin) => pin.position));
			worker.postMessage({type: "map", epoch, positions, indices: triangles, floorIds: floors, points,
				tolerance: VISUAL.occlusionTolerance}, [positions.buffer, triangles.buffer, floors.buffer, points.buffer]);
		},
		update(viewport, floorRange) {
			if (!viewport) return;
			// In an orthographic view, panning and zooming cannot change occlusion.
			const matrix = viewport.viewMatrix;
			const length = Math.hypot(matrix[2], matrix[6], matrix[10]);
			const direction = [matrix[2], matrix[6], matrix[10]].map((value) => value / length);
			const key = [...direction.map((value) => value.toFixed(10)), ...(floorRange ?? [])].join("|");
			if (key === viewKey) return;
			viewKey = key;
			pending = {direction, floorRange};
			dispatch();
		},
		get revision() { return revision; },
		brightness(pin) {
			if (pin.markerType === "position_marker") return 1;
			const index = indices.get(pin.id);
			if (index === undefined) throw new Error(`Unregistered occlusion pin: ${pin.id}`);
			return brightness[index];
		},
	};
}
