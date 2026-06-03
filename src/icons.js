import { APP_CONFIG } from "./config.js";

const iconCache = new Map();

function colorToCss(color) {
	const [red, green, blue, alpha = 255] = color;

	return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function svgDataUrl(svg) {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function pinIconSvg(width, height, fillColor, outlineColor) {
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 28 36">
	<path d="M14 34C11.4 30.5 3 20.8 3 12.8C3 6.3 7.9 2 14 2C20.1 2 25 6.3 25 12.8C25 20.8 16.6 30.5 14 34Z" fill="${fillColor}" stroke="${outlineColor}" stroke-width="2" stroke-linejoin="round"/>
	<circle cx="14" cy="12.8" r="5.2" fill="rgba(10, 12, 18, 0.22)" stroke="rgba(255, 255, 255, 0.55)" stroke-width="1.4"/>
</svg>`;
}

export function pinIconForCategory(category) {
	const pinsConfig = APP_CONFIG.runtime.visual.pins;
	const categoryConfig = pinsConfig.categories[category] ?? {};
	const color = categoryConfig.color ?? [255, 255, 255, 245];
	const outlineColor = categoryConfig.outlineColor ?? [0, 0, 0, 255];
	const textureScale = pinsConfig.iconTextureScale ?? 1;
	const textureWidth = pinsConfig.iconWidth * textureScale;
	const textureHeight = pinsConfig.iconHeight * textureScale;
	const cacheKey = `${textureWidth}x${textureHeight}:${color.join(",")}:${outlineColor.join(",")}`;

	if (!iconCache.has(cacheKey)) {
		iconCache.set(cacheKey, {
			url: svgDataUrl(pinIconSvg(textureWidth, textureHeight, colorToCss(color), colorToCss(outlineColor))),
			width: textureWidth,
			height: textureHeight,
			anchorX: textureWidth / 2,
			anchorY: textureHeight,
		});
	}

	return iconCache.get(cacheKey);
}
