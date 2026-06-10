import { localizeValue } from "./i18n.js";
import { APP_CONFIG } from "./config.js";

const PIN_BELLY_CENTER_Y = 12.8 / 36;
const PIN_BELLY_CENTER_FROM_TIP = 1 - PIN_BELLY_CENTER_Y;
const TOOLTIP_SIDE_LEFT = "tooltip-side-left";
const TOOLTIP_SIDE_RIGHT = "tooltip-side-right";

export function createMarkerOverlays({
	markerPopup,
	markerPopupTitle,
	markerPopupType,
	markerPopupDescription,
	markerTooltip,
	auxiliaryArrow,
	auxiliaryArrowArc,
	auxiliaryArrowArcOutline,
	mapRenderer,
	categoryTitle,
	markerName,
	onCopyMarkerUrl,
	onCopyMarkerUrlError,
}) {
	let activeMarker = null;
	let activeTooltipMarker = null;
	let auxiliaryTooltipElements = [];

	function auxiliaryMarkers(marker) {
		return marker?.auxiliaryMarkers ?? [];
	}

	function isAuxiliaryMarker(marker) {
		return marker?.markerType === "auxiliary_pin" && marker.parentMarker;
	}

	function colorToCss(color) {
		const [red, green, blue, alpha = 255] = color;

		return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
	}

	function outlineColorFor(color) {
		const [red, green, blue] = color;
		const scale = 0.28;

		return [
			Math.round(red * scale),
			Math.round(green * scale),
			Math.round(blue * scale),
			255,
		];
	}

	function markerColor(marker) {
		return APP_CONFIG.runtime.visual.pins.categories[marker.category]?.color ?? [255, 255, 255, 245];
	}

	function auxiliaryPoints(marker, auxiliary) {
		const start = mapRenderer.projectPosition(marker.position);
		const end = mapRenderer.projectPosition(auxiliary.position);

		if (!start || !end) {
			return null;
		}

		const pinHeight = APP_CONFIG.runtime.visual.pins.iconHeight;
		const auxiliaryPinHeight = pinHeight * APP_CONFIG.runtime.visual.auxiliaryLinks.auxiliaryPinScale;

		return {
			start: {
				x: start.x,
				y: start.y - pinHeight * PIN_BELLY_CENTER_FROM_TIP,
			},
			end: {
				x: end.x,
				y: end.y - auxiliaryPinHeight * PIN_BELLY_CENTER_FROM_TIP,
			},
		};
	}

	function normalize(vector) {
		const length = Math.hypot(vector.x, vector.y);

		if (length <= 0) {
			return null;
		}

		return {
			x: vector.x / length,
			y: vector.y / length,
		};
	}

	function offsetPoint(point, direction, distance) {
		return {
			x: point.x + direction.x * distance,
			y: point.y + direction.y * distance,
		};
	}

	function angleOf(vector) {
		return Math.atan2(vector.y, vector.x);
	}

	function normalizeAngle(angle) {
		let value = angle;

		while (value <= -Math.PI) {
			value += Math.PI * 2;
		}

		while (value > Math.PI) {
			value -= Math.PI * 2;
		}

		return value;
	}

	function directionFromAngle(angle) {
		return {
			x: Math.cos(angle),
			y: Math.sin(angle),
		};
	}

	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}

	function auxiliaryArrowControl(start, end) {
		const direction = normalize({
			x: end.x - start.x,
			y: end.y - start.y,
		});

		if (!direction) {
			return {
				x: (start.x + end.x) / 2,
				y: (start.y + end.y) / 2,
			};
		}

		const midpoint = {
			x: (start.x + end.x) / 2,
			y: (start.y + end.y) / 2,
		};
		const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
		const distance = Math.hypot(end.x - start.x, end.y - start.y);
		const horizontalness = Math.abs(direction.x);
		const firstNormal = {x: -direction.y, y: direction.x};
		const secondNormal = {x: -firstNormal.x, y: -firstNormal.y};
		const verticalEpsilon = 0.0001;
		const upperNormal = Math.abs(firstNormal.y - secondNormal.y) <= verticalEpsilon
			? null
			: (firstNormal.y < secondNormal.y ? firstNormal : secondNormal);

		if (!upperNormal) {
			return midpoint;
		}

		const curve = distance * links.arcDistanceRatio * horizontalness;
		const maxTilt = links.arcMaxTiltDegrees * Math.PI / 180;
		const upwardAngle = -Math.PI / 2;
		const normalAngle = angleOf(upperNormal);
		const controlAngle = normalAngle + clamp(
			normalizeAngle(upwardAngle - normalAngle),
			-maxTilt,
			maxTilt,
		);
		const controlDirection = directionFromAngle(controlAngle);

		return offsetPoint(midpoint, controlDirection, curve);
	}

	function quadraticPoint(start, control, end, t) {
		const inverse = 1 - t;

		return {
			x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
			y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
		};
	}

	function sampleCurve(start, control, end, samples) {
		const points = [];
		let length = 0;
		let previous = null;

		for (let index = 0; index <= samples; index++) {
			const point = quadraticPoint(start, control, end, index / samples);

			if (previous) {
				length += Math.hypot(point.x - previous.x, point.y - previous.y);
			}

			points.push({
				...point,
				length,
			});
			previous = point;
		}

		return {
			length,
			points,
		};
	}

	function curveTangentAtStart(start, control) {
		return normalize({
			x: control.x - start.x,
			y: control.y - start.y,
		});
	}

	function curveTangentAtEnd(end, control) {
		return normalize({
			x: end.x - control.x,
			y: end.y - control.y,
		});
	}

	function arrowShapePath(centerline, tangent) {
		const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
		const tip = centerline[centerline.length - 1];
		const totalLength = centerline[centerline.length - 1]?.length ?? 0;

		if (!tangent) {
			return "";
		}

		const baseDistance = totalLength - links.arrowHeadLength;

		if (baseDistance <= links.arcWidth * 2) {
			return "";
		}

		const base = pointOnCenterline(centerline, baseDistance);
		const shaftHalfWidth = links.arcWidth / 2;
		const left = [];
		const right = [];
		const shaft = centerline
			.filter((point) => point.length < baseDistance)
			.concat(base);

		if (shaft.length < 2) {
			return "";
		}

		for (let index = 0; index < shaft.length; index++) {
			const point = shaft[index];
			const next = shaft[Math.min(shaft.length - 1, index + 1)];
			const previous = shaft[Math.max(0, index - 1)];
			const direction = normalize({
				x: next.x - previous.x,
				y: next.y - previous.y,
			});

			if (!direction) {
				continue;
			}

			const normal = {x: -direction.y, y: direction.x};

			left.push(offsetPoint(point, normal, shaftHalfWidth));
			right.push(offsetPoint(point, {x: -normal.x, y: -normal.y}, shaftHalfWidth));
		}

		const headNormal = {x: -tangent.y, y: tangent.x};
		const headLeft = offsetPoint(base, headNormal, links.arrowHeadWidth / 2);
		const headRight = offsetPoint(base, {x: -headNormal.x, y: -headNormal.y}, links.arrowHeadWidth / 2);
		const points = [
			...left,
			headLeft,
			tip,
			headRight,
			...right.reverse(),
		];
		const [first, ...rest] = points;

		return [
			`M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`,
			...rest.map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
			"Z",
		].join(" ");
	}

	function pointOnCenterline(centerline, distance) {
		for (let index = 1; index < centerline.length; index++) {
			const previous = centerline[index - 1];
			const current = centerline[index];

			if (current.length < distance) {
				continue;
			}

			const span = current.length - previous.length;
			const t = span > 0 ? (distance - previous.length) / span : 0;

			return {
				x: previous.x + (current.x - previous.x) * t,
				y: previous.y + (current.y - previous.y) * t,
				length: distance,
			};
		}

		return centerline[centerline.length - 1];
	}

	function mix(left, right, t) {
		return left + (right - left) * t;
	}

	function pinGapForDirection(direction, scale) {
		const pins = APP_CONFIG.runtime.visual.pins;
		const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
		const horizontalRadius = pins.iconWidth * scale * 0.5;
		const bottomRadius = pins.iconHeight * scale * 0.64;
		const bottomFactor = Math.max(0, direction.y) ** 2;

		return mix(horizontalRadius, bottomRadius, bottomFactor) + links.arrowPadding;
	}

	function auxiliaryArrowGeometry(points) {
		const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
		const baseControl = auxiliaryArrowControl(points.start, points.end);
		const startTangent = curveTangentAtStart(points.start, baseControl);
		const endTangent = curveTangentAtEnd(points.end, baseControl);

		if (!startTangent || !endTangent) {
			return null;
		}

		const startGap = pinGapForDirection(startTangent, 1);
		const endDirection = {x: -endTangent.x, y: -endTangent.y};
		const endGap = pinGapForDirection(endDirection, links.auxiliaryPinScale);
		const start = offsetPoint(points.start, startTangent, startGap);
		const end = offsetPoint(points.end, endDirection, endGap);
		const control = auxiliaryArrowControl(start, end);
		const curve = sampleCurve(start, control, end, 36);
		const minimumLength = links.arrowHeadLength + links.arcWidth * 2;

		if (curve.length < minimumLength) {
			return null;
		}

		return arrowShapePath(curve.points, curveTangentAtEnd(end, control));
	}

	function setAuxiliaryArrowVisibility(visible) {
		auxiliaryArrow.style.visibility = visible ? "visible" : "hidden";
	}

	function auxiliarySide(marker) {
		if (isAuxiliaryMarker(marker)) {
			const points = auxiliaryPoints(marker.parentMarker, marker);

			if (!points) {
				return null;
			}

			return points.end.x >= points.start.x ? "right" : "left";
		}

		let leftCount = 0;
		let rightCount = 0;

		for (const auxiliary of auxiliaryMarkers(marker)) {
			const points = auxiliaryPoints(marker, auxiliary);

			if (!points) {
				continue;
			}

			if (points.end.x >= points.start.x) {
				rightCount++;
			} else {
				leftCount++;
			}
		}

		return rightCount > leftCount ? "left" : "right";
	}

	function setTooltipSide(element, side) {
		element.classList.toggle(TOOLTIP_SIDE_LEFT, side === "left");
		element.classList.toggle(TOOLTIP_SIDE_RIGHT, side !== "left");
	}

	function placeTooltip(element, anchor, side, offsetX) {
		setTooltipSide(element, side);

		if (side === "left") {
			const width = element.getBoundingClientRect().width;

			element.style.left = `${anchor.x - offsetX - width}px`;
		} else {
			element.style.left = `${anchor.x + offsetX}px`;
		}

		element.style.top = `${anchor.y}px`;
	}

	function ensureAuxiliaryTooltipCount(count) {
		const parent = markerTooltip.parentElement;

		while (auxiliaryTooltipElements.length < count) {
			const element = document.createElement("div");

			element.className = "marker-tooltip auxiliary-tooltip";
			element.hidden = true;
			parent.append(element);
			auxiliaryTooltipElements.push(element);
		}

		while (auxiliaryTooltipElements.length > count) {
			auxiliaryTooltipElements.pop().remove();
		}
	}

	function hideAuxiliaryTooltips() {
		for (const element of auxiliaryTooltipElements) {
			element.hidden = true;
		}
	}

	function activeAuxiliaryOwner() {
		const marker = isAuxiliaryMarker(activeTooltipMarker)
			? activeTooltipMarker.parentMarker
			: activeTooltipMarker;
		const owner = activeMarker ?? marker;

		return auxiliaryMarkers(owner).length > 0 ? owner : null;
	}

	function updateAuxiliaryTooltips() {
		const marker = activeAuxiliaryOwner();

		if (!marker) {
			hideAuxiliaryTooltips();
			return;
		}

		const auxiliaries = auxiliaryMarkers(marker);
		const [offsetX, offsetY] = APP_CONFIG.runtime.visual.auxiliaryLinks.tooltipOffset;
		const pinHeight = APP_CONFIG.runtime.visual.pins.iconHeight * APP_CONFIG.runtime.visual.auxiliaryLinks.auxiliaryPinScale;
		const pinWidth = APP_CONFIG.runtime.visual.pins.iconWidth * APP_CONFIG.runtime.visual.auxiliaryLinks.auxiliaryPinScale;

		ensureAuxiliaryTooltipCount(auxiliaries.length);

		for (let index = 0; index < auxiliaries.length; index++) {
			const auxiliary = auxiliaries[index];
			const element = auxiliaryTooltipElements[index];
			const point = mapRenderer.projectPosition(auxiliary.position);

			if (!point) {
				element.hidden = true;
				continue;
			}

			const side = auxiliarySide({
				...auxiliary,
				markerType: "auxiliary_pin",
				parentMarker: marker,
			}) ?? "right";
			const anchor = {
				x: point.x,
				y: point.y - pinHeight * PIN_BELLY_CENTER_FROM_TIP + offsetY,
			};

			element.textContent = markerName(auxiliary);
			element.hidden = false;
			placeTooltip(element, anchor, side, pinWidth / 2 + offsetX);
		}
	}

	function updateAuxiliaryMarkers() {
		const marker = activeAuxiliaryOwner();

		if (!marker) {
			setAuxiliaryArrowVisibility(false);
			hideAuxiliaryTooltips();
			mapRenderer.setAuxiliaryMarkerOwner(null);
			return;
		}

		mapRenderer.setAuxiliaryMarkerOwner(marker);
		updateAuxiliaryArrow();
		updateAuxiliaryTooltips();
	}

	function hidePopup() {
		activeMarker = null;
		markerPopup.hidden = true;
		updateAuxiliaryMarkers();
	}

	function hideTooltip() {
		activeTooltipMarker = null;
		markerTooltip.hidden = true;
		updateAuxiliaryMarkers();
	}

	function updatePopupPosition() {
		if (!activeMarker || markerPopup.hidden) {
			return;
		}

		const point = mapRenderer.projectPosition(activeMarker.position);

		if (!point) {
			return;
		}

		markerPopup.style.left = `${point.x}px`;
		markerPopup.style.top = `${point.y}px`;
	}

	function updateTooltipPosition() {
		if (!activeTooltipMarker || markerTooltip.hidden) {
			return;
		}

		const point = mapRenderer.projectPosition(activeTooltipMarker.position);

		if (!point) {
			return;
		}

		const [offsetX, offsetY] = APP_CONFIG.runtime.visual.pins.tooltipOffset;
		const side = auxiliarySide(activeTooltipMarker);

		if (side) {
			const iconHeight = isAuxiliaryMarker(activeTooltipMarker)
				? APP_CONFIG.runtime.visual.pins.iconHeight * APP_CONFIG.runtime.visual.auxiliaryLinks.auxiliaryPinScale
				: APP_CONFIG.runtime.visual.pins.iconHeight;
			const anchor = {
				x: point.x,
				y: point.y - iconHeight * PIN_BELLY_CENTER_FROM_TIP,
			};

			placeTooltip(markerTooltip, anchor, side, offsetX);
			return;
		}

		setTooltipSide(markerTooltip, "right");
		markerTooltip.style.left = `${point.x + offsetX}px`;
		markerTooltip.style.top = `${point.y + offsetY}px`;
	}

	function updateAuxiliaryArrow() {
		const marker = activeAuxiliaryOwner();

		if (!marker) {
			setAuxiliaryArrowVisibility(false);
			return false;
		}

		const color = markerColor(marker);
		const outlineColor = outlineColorFor(color);
		const arrowPath = auxiliaryMarkers(marker)
			.map((auxiliary) => {
				const points = auxiliaryPoints(marker, auxiliary);

				return points ? auxiliaryArrowGeometry(points) : null;
			})
			.filter(Boolean)
			.join(" ");
		const bounds = auxiliaryArrow.getBoundingClientRect();
		const width = bounds.width;
		const height = bounds.height;

		if (!arrowPath || width <= 0 || height <= 0) {
			setAuxiliaryArrowVisibility(false);
			return false;
		}

		auxiliaryArrow.setAttribute("viewBox", `0 0 ${width} ${height}`);
		auxiliaryArrow.setAttribute("width", width);
		auxiliaryArrow.setAttribute("height", height);

		auxiliaryArrowArc.setAttribute("stroke", colorToCss(color));
		auxiliaryArrowArc.setAttribute("stroke-width", 0);
		auxiliaryArrowArc.style.fill = colorToCss(color);
		auxiliaryArrowArcOutline.setAttribute("stroke", colorToCss(outlineColor));
		auxiliaryArrowArcOutline.setAttribute("stroke-width", APP_CONFIG.runtime.visual.auxiliaryLinks.arcOutlineWidth);
		auxiliaryArrowArcOutline.style.fill = colorToCss(color);

		auxiliaryArrowArc.setAttribute("d", arrowPath);
		auxiliaryArrowArcOutline.setAttribute("d", arrowPath);
		setAuxiliaryArrowVisibility(true);

		return true;
	}

	function update() {
		updatePopupPosition();
		updateTooltipPosition();
		updateAuxiliaryArrow();
		updateAuxiliaryTooltips();
	}

	function showPopup(marker) {
		if (!marker) {
			hidePopup();

			return;
		}

		activeMarker = marker;
		markerPopupTitle.textContent = markerName(marker);
		markerPopupType.textContent = categoryTitle(marker.category);
		markerPopupDescription.hidden = !marker.description;
		markerPopupDescription.textContent = marker.description
			? localizeValue(marker.description, "")
			: "";
		markerPopup.hidden = false;
		updatePopupPosition();
		updateAuxiliaryMarkers();
	}

	function showTooltip(marker) {
		if (!marker) {
			hideTooltip();

			return;
		}

		activeTooltipMarker = marker;

		if (isAuxiliaryMarker(marker)) {
			markerTooltip.hidden = true;
			updateAuxiliaryMarkers();
			return;
		}

		markerTooltip.textContent = markerName(marker);
		markerTooltip.hidden = false;
		updateTooltipPosition();
		updateAuxiliaryMarkers();
	}

	function copyActiveMarkerUrl() {
		if (!onCopyMarkerUrl || !activeMarker) {
			return;
		}

		onCopyMarkerUrl(activeMarker).catch(onCopyMarkerUrlError);
	}

	markerPopupTitle.addEventListener("click", copyActiveMarkerUrl);

	function hideForCategory(category) {
		if (activeMarker?.category === category) {
			hidePopup();
		}

		if (activeTooltipMarker?.category === category) {
			hideTooltip();
		}
	}

	return {
		hidePopup,
		hideTooltip,
		hideForCategory,
		showPopup,
		showTooltip,
		update,
	};
}
