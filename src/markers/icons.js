import { APP_CONFIG } from "../config.js";

const iconCache = new Map();

function colorToCss(color) {
	const [red, green, blue, alpha = 255] = color;

	return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function outlineColorFor(fillColor) {
	const [red, green, blue] = fillColor;
	const scale = 0.28;

	return [
		Math.round(red * scale),
		Math.round(green * scale),
		Math.round(blue * scale),
		255,
	];
}

function svgDataUrl(svg) {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function scaledPinPath(width, height) {
	const sx = width / 28;
	const sy = height / 36;
	const point = (x, y) => `${(x * sx).toFixed(3)} ${(y * sy).toFixed(3)}`;

	return [
		`M ${point(14, 34)}`,
		`C ${point(11.4, 30.5)} ${point(3, 20.8)} ${point(3, 12.8)}`,
		`C ${point(3, 6.3)} ${point(7.9, 2)} ${point(14, 2)}`,
		`C ${point(20.1, 2)} ${point(25, 6.3)} ${point(25, 12.8)}`,
		`C ${point(25, 20.8)} ${point(16.6, 30.5)} ${point(14, 34)}`,
		"Z",
	].join(" ");
}

function pinIconSvg(width, height, fillColor, outlineColor, options = {}) {
	const strokeWidth = options.strokeWidth ?? 2;
	const centerCircle = options.centerCircle === false
		? ""
		: `\n\t<circle cx="${(width / 2).toFixed(3)}" cy="${(height * 12.8 / 36).toFixed(3)}" r="${(height * 5.2 / 36).toFixed(3)}" fill="rgba(10, 12, 18, 0.22)" stroke="rgba(255, 255, 255, 0.55)" stroke-width="${options.centerStrokeWidth ?? 1.4}"/>`;

	return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
	<path d="${scaledPinPath(width, height)}" fill="${fillColor}" stroke="${outlineColor}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>${centerCircle}
</svg>`;
}

function crossIconSvg(size, color, outlineColor, outlineWidth) {
	const center = size / 2;
	const radius = size * 0.3;
	const fillWidth = Math.max(2, size * 0.13);
	const outlineStrokeWidth = fillWidth + outlineWidth * 2;
	const lines = [
		[center - radius, center - radius, center + radius, center + radius],
		[center + radius, center - radius, center - radius, center + radius],
	];
	const path = lines
		.map(([x1, y1, x2, y2]) => `M ${x1.toFixed(3)} ${y1.toFixed(3)} L ${x2.toFixed(3)} ${y2.toFixed(3)}`)
		.join(" ");

	return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
	<path d="${path}" fill="none" stroke="${outlineColor}" stroke-width="${outlineStrokeWidth}" stroke-linecap="square"/>
	<path d="${path}" fill="none" stroke="${color}" stroke-width="${fillWidth}" stroke-linecap="square"/>
</svg>`;
}

export function pinIconForCategory(category, options = {}) {
	const pinsConfig = APP_CONFIG.runtime.visual.pins;
	const categoryConfig = pinsConfig.categories[category] ?? {};
	const color = categoryConfig.color ?? [255, 255, 255, 245];
	const outlineColor = outlineColorFor(color);
	const textureScale = pinsConfig.iconTextureScale ?? 1;
	const iconWidth = options.iconWidth ?? pinsConfig.iconWidth;
	const iconHeight = options.iconHeight ?? pinsConfig.iconHeight;
	const textureWidth = iconWidth * textureScale;
	const textureHeight = iconHeight * textureScale;
	const strokeWidth = (options.strokeWidth ?? 2) * textureScale;
	const centerStrokeWidth = (options.centerStrokeWidth ?? 1.4) * textureScale;
	const cacheKey = `${textureWidth}x${textureHeight}:${color.join(",")}:${options.centerCircle !== false}:${strokeWidth}:${centerStrokeWidth}`;

	if (!iconCache.has(cacheKey)) {
		iconCache.set(cacheKey, {
			url: svgDataUrl(pinIconSvg(textureWidth, textureHeight, colorToCss(color), colorToCss(outlineColor), {
				...options,
				centerStrokeWidth,
				strokeWidth,
			})),
			width: textureWidth,
			height: textureHeight,
			anchorX: textureWidth / 2,
			anchorY: textureHeight,
		});
	}

	return iconCache.get(cacheKey);
}

export function positionMarkerIcon() {
	const config = APP_CONFIG.runtime.visual.positionMarker;
	const textureScale = config.iconTextureScale ?? 1;
	const textureSize = config.iconSize * textureScale;
	const outlineWidth = config.outlineWidth * textureScale;
	const cacheKey = `position:${textureSize}:${config.color.join(",")}:${config.outlineColor.join(",")}:${outlineWidth}`;

	if (!iconCache.has(cacheKey)) {
		iconCache.set(cacheKey, {
			url: svgDataUrl(crossIconSvg(textureSize, colorToCss(config.color), colorToCss(config.outlineColor), outlineWidth)),
			width: textureSize,
			height: textureSize,
			anchorX: textureSize / 2,
			anchorY: textureSize / 2,
		});
	}

	return iconCache.get(cacheKey);
}
