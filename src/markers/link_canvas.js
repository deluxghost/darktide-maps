import { APP_CONFIG } from "../config.js";
import {
	LINK_DATA_FLOATS, LINK_PART, LINK_PART_COUNT, LINK_TEXTURE, LINK_VERTEX_ATTRIBUTES,
	LINK_VERTEX_KIND, LINK_VERTEX_STRIDE, markerLinkSegments, markerLinkTemplate, writeMarkerLink,
} from "./link_mesh.js";

const ARROW_ATTRIBUTE_OFFSET = LINK_VERTEX_ATTRIBUTES.indexOf("arrowIndex");
const VERTEX = `#version 300 es
precision highp float;
in float pointIndex;
in float edgeIndex;
in float side;
in float kind;
in float part;
in float arrowIndex;
uniform sampler2D curves;
uniform vec2 viewport;
uniform vec2 offset;
uniform float layers;
uniform float radius;
out vec4 ink;
const float PI = 3.141592653589793;
vec4 datum(int column) { return texelFetch(curves, ivec2(column, int(arrowIndex)), 0); }
vec2 point(int index) {
	vec4 info = datum(${LINK_TEXTURE.HEAD_TIP});
	int segments = int(info.w);
	int total = 2 * (segments + 1) + 3;
	index = (index + total) % total;
	if (index == segments + 1) return datum(${LINK_TEXTURE.HEAD_BASE}).xy;
	if (index == segments + 2) return datum(${LINK_TEXTURE.HEAD_BASE}).zw;
	if (index == segments + 3) return info.xy;
	bool left = index <= segments;
	int step = left ? index : total - 1 - index;
	float t = float(step) / float(segments), u = 1.0 - t;
	vec4 value = u*u*u*datum(0) + 3.0*u*u*t*datum(1) + 3.0*u*t*t*datum(2) + t*t*t*datum(3);
	return left ? value.xy : value.zw;
}
void main() {
	int index = int(pointIndex);
	vec2 position = point(index);
	if (kind == ${LINK_VERTEX_KIND.EDGE}.0) {
		vec2 direction = normalize(point(int(edgeIndex) + 1) - point(int(edgeIndex)));
		position += vec2(-direction.y, direction.x) * radius * side;
	} else if (kind == ${LINK_VERTEX_KIND.JOIN}.0) {
		vec2 previous = normalize(position - point(index - 1));
		vec2 next = normalize(point(index + 1) - position);
		float turn = atan(previous.x * next.y - previous.y * next.x, dot(previous, next));
		float angle = atan(previous.y, previous.x) + (turn > 0.0 ? -PI / 2.0 : PI / 2.0) + turn * side;
		position += vec2(cos(angle), sin(angle)) * radius;
	}
	vec2 pixel = (position + offset) / viewport;
	float layer = arrowIndex * ${LINK_PART_COUNT}.0 + part;
	gl_Position = vec4(pixel.x * 2.0 - 1.0, 1.0 - pixel.y * 2.0, 1.0 - 1.9 * (layer + 1.0) / (layers + 1.0), 1.0);
	vec4 color = datum(part == ${LINK_PART.OUTLINE}.0 ? ${LINK_TEXTURE.OUTLINE_COLOR} : ${LINK_TEXTURE.FILL_COLOR});
	color.a *= part == ${LINK_PART.TOP_FILL}.0 ? 0.98 : 0.95;
	ink = vec4(color.rgb * color.a, color.a);
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
in vec4 ink;
out vec4 pixel;
void main() { pixel = ink; }`;

function shader(gl, type, source) {
	const result = gl.createShader(type);
	gl.shaderSource(result, source);
	gl.compileShader(result);
	if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
	return result;
}

export function createMarkerLinkCanvas(canvas, outlineWidth) {
	const gl = canvas.getContext("webgl2", {alpha: true, antialias: true, depth: true, premultipliedAlpha: true});
	if (!gl) throw new Error("Cannot create the marker link WebGL context.");
	const program = gl.createProgram();
	const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX), fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
	gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
	gl.deleteShader(vertex); gl.deleteShader(fragment); gl.useProgram(program);
	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
	for (const [index, name] of LINK_VERTEX_ATTRIBUTES.entries()) {
		const location = gl.getAttribLocation(program, name);
		gl.enableVertexAttribArray(location);
		gl.vertexAttribPointer(location, 1, gl.FLOAT, false, LINK_VERTEX_STRIDE * Float32Array.BYTES_PER_ELEMENT, index * Float32Array.BYTES_PER_ELEMENT);
	}
	gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	const viewport = gl.getUniformLocation(program, "viewport"), translation = gl.getUniformLocation(program, "offset");
	const layers = gl.getUniformLocation(program, "layers");
	gl.uniform1i(gl.getUniformLocation(program, "curves"), 0);
	gl.uniform1f(gl.getUniformLocation(program, "radius"), outlineWidth / 2);
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	// Equal-depth stroke pieces form one union instead of accumulating opacity at joins.
	gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
	gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
	let previous = [], topology = "", vertexCount = 0;
	const templates = new Map();
	return function paint(arrows, offset, bounds) {
		const ratio = window.devicePixelRatio;
		const width = Math.round(bounds.width * ratio), height = Math.round(bounds.height * ratio);
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		gl.viewport(0, 0, width, height); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		canvas.style.visibility = arrows.length ? "visible" : "hidden";
		canvas.dataset.arrowCount = arrows.length;
		if (!arrows.length) {previous = []; return;}
		const changed = arrows.length !== previous.length || arrows.some((arrow, index) =>
			arrow.geometry !== previous[index].geometry || arrow.color !== previous[index].color);
		if (changed) {
			const segments = arrows.map(({geometry}) => markerLinkSegments(geometry, APP_CONFIG.runtime.visual.auxiliaryLinks.arcPixelTolerance));
			const data = new Float32Array(Math.max(1, arrows.length) * LINK_DATA_FLOATS);
			arrows.forEach((arrow, index) => writeMarkerLink(data, index * LINK_DATA_FLOATS, arrow, segments[index]));
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, LINK_TEXTURE.COLUMNS, Math.max(1, arrows.length), 0, gl.RGBA, gl.FLOAT, data);
			const key = segments.join("|");
			if (topology !== key) {
				const chunks = segments.map((count) => {
					if (!templates.has(count)) templates.set(count, markerLinkTemplate(count));
					return templates.get(count);
				});
				const vertices = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
				let start = 0;
				chunks.forEach((chunk, index) => {
					vertices.set(chunk, start);
					for (let item = start + ARROW_ATTRIBUTE_OFFSET; item < start + chunk.length; item += LINK_VERTEX_STRIDE) vertices[item] = index;
					start += chunk.length;
				});
				gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
				vertexCount = vertices.length / LINK_VERTEX_STRIDE;
				topology = key;
			}
			previous = arrows.map(({geometry, color}) => ({geometry, color}));
		}
		gl.uniform2f(viewport, bounds.width, bounds.height); gl.uniform2f(translation, offset.x, offset.y);
		gl.uniform1f(layers, arrows.length * LINK_PART_COUNT); gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
	};
}
