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
	relationArrow,
	relationArrowArc,
	relationArrowArcOutline,
	relationTooltip,
	mapRenderer,
	categoryTitle,
	markerName,
}) {
	let activeMarker = null;
	let activeTooltipMarker = null;

	function bossTriggerRelation(marker) {
		return marker?.relations?.find((relation) => relation.type === "boss_trigger" && relation.position);
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

	function relationPoints(marker, relation) {
		const start = mapRenderer.projectPosition(marker.position);
		const end = mapRenderer.projectPosition(relation.position);

		if (!start || !end) {
			return null;
		}

		const pinHeight = APP_CONFIG.runtime.visual.pins.iconHeight;
		const relationPinHeight = pinHeight * APP_CONFIG.runtime.visual.relations.triggerPinScale;

		return {
			start: {
				x: start.x,
				y: start.y - pinHeight * PIN_BELLY_CENTER_FROM_TIP,
			},
			end: {
				x: end.x,
				y: end.y - relationPinHeight * PIN_BELLY_CENTER_FROM_TIP,
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

	function relationControl(start, end) {
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
		const relations = APP_CONFIG.runtime.visual.relations;
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

		const curve = distance * relations.arcDistanceRatio * horizontalness;
		const maxTilt = relations.arcMaxTiltDegrees * Math.PI / 180;
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
		const relations = APP_CONFIG.runtime.visual.relations;
		const tip = centerline[centerline.length - 1];
		const totalLength = centerline[centerline.length - 1]?.length ?? 0;

		if (!tangent) {
			return "";
		}

		const baseDistance = totalLength - relations.arrowHeadLength;

		if (baseDistance <= relations.arcWidth * 2) {
			return "";
		}

		const base = pointOnCenterline(centerline, baseDistance);
		const shaftHalfWidth = relations.arcWidth / 2;
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
		const headLeft = offsetPoint(base, headNormal, relations.arrowHeadWidth / 2);
		const headRight = offsetPoint(base, {x: -headNormal.x, y: -headNormal.y}, relations.arrowHeadWidth / 2);
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
		const relations = APP_CONFIG.runtime.visual.relations;
		const horizontalRadius = pins.iconWidth * scale * 0.5;
		const bottomRadius = pins.iconHeight * scale * 0.64;
		const bottomFactor = Math.max(0, direction.y) ** 2;

		return mix(horizontalRadius, bottomRadius, bottomFactor) + relations.arrowPadding;
	}

	function relationGeometry(points) {
		const relations = APP_CONFIG.runtime.visual.relations;
		const baseControl = relationControl(points.start, points.end);
		const startTangent = curveTangentAtStart(points.start, baseControl);
		const endTangent = curveTangentAtEnd(points.end, baseControl);

		if (!startTangent || !endTangent) {
			return null;
		}

		const startGap = pinGapForDirection(startTangent, 1);
		const endDirection = {x: -endTangent.x, y: -endTangent.y};
		const endGap = pinGapForDirection(endDirection, relations.triggerPinScale);
		const start = offsetPoint(points.start, startTangent, startGap);
		const end = offsetPoint(points.end, endDirection, endGap);
		const control = relationControl(start, end);
		const curve = sampleCurve(start, control, end, 36);
		const minimumLength = relations.arrowHeadLength + relations.arcWidth * 2;

		if (curve.length < minimumLength) {
			return null;
		}

		return arrowShapePath(curve.points, curveTangentAtEnd(end, control));
	}

	function setRelationArrowVisibility(visible) {
		relationArrow.style.visibility = visible ? "visible" : "hidden";
	}

	function relationSides(marker) {
		const relation = bossTriggerRelation(marker);
		const points = relation ? relationPoints(marker, relation) : null;

		if (!points) {
			return null;
		}

		const relationOnRight = points.end.x >= points.start.x;

		return {
			marker: relationOnRight ? "left" : "right",
			relation: relationOnRight ? "right" : "left",
		};
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

	function activeRelationMarker() {
		const marker = activeMarker ?? activeTooltipMarker;

		return bossTriggerRelation(marker) ? marker : null;
	}

	function updateRelationMarker() {
		const marker = activeRelationMarker();

		if (!marker) {
			setRelationArrowVisibility(false);
			relationTooltip.hidden = true;
			mapRenderer.setRelationMarker(null);
			return;
		}

		relationTooltip.hidden = false;
		mapRenderer.setRelationMarker(marker);
		updateRelationArrow();
		updateRelationTooltipPosition();
	}

	function hidePopup() {
		activeMarker = null;
		markerPopup.hidden = true;
		updateRelationMarker();
	}

	function hideTooltip() {
		activeTooltipMarker = null;
		markerTooltip.hidden = true;
		updateRelationMarker();
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
		const sides = relationSides(activeTooltipMarker);

		if (sides) {
			const anchor = {
				x: point.x,
				y: point.y - APP_CONFIG.runtime.visual.pins.iconHeight * PIN_BELLY_CENTER_FROM_TIP,
			};

			placeTooltip(markerTooltip, anchor, sides.marker, offsetX);
			return;
		}

		setTooltipSide(markerTooltip, "right");
		markerTooltip.style.left = `${point.x + offsetX}px`;
		markerTooltip.style.top = `${point.y + offsetY}px`;
	}

	function updateRelationTooltipPosition() {
		const relation = bossTriggerRelation(activeRelationMarker());

		if (!relation || relationTooltip.hidden) {
			return;
		}

		const point = mapRenderer.projectPosition(relation.position);

		if (!point) {
			return;
		}

		const [offsetX, offsetY] = APP_CONFIG.runtime.visual.relations.tooltipOffset;
		const pinHeight = APP_CONFIG.runtime.visual.pins.iconHeight * APP_CONFIG.runtime.visual.relations.triggerPinScale;
		const pinWidth = APP_CONFIG.runtime.visual.pins.iconWidth * APP_CONFIG.runtime.visual.relations.triggerPinScale;
		const marker = activeRelationMarker();
		const sides = relationSides(marker);
		const anchor = {
			x: point.x,
			y: point.y - pinHeight * PIN_BELLY_CENTER_FROM_TIP + offsetY,
		};

		placeTooltip(relationTooltip, anchor, sides?.relation ?? "right", pinWidth / 2 + offsetX);
	}

	function updateRelationArrow() {
		const marker = activeRelationMarker();
		const relation = bossTriggerRelation(marker);

		if (!relation) {
			setRelationArrowVisibility(false);
			return false;
		}

		const points = relationPoints(marker, relation);

		if (!points) {
			setRelationArrowVisibility(false);
			return false;
		}

		const color = markerColor(marker);
		const outlineColor = outlineColorFor(color);
		const arrowPath = relationGeometry(points);
		const bounds = relationArrow.getBoundingClientRect();
		const width = bounds.width;
		const height = bounds.height;

		if (!arrowPath || width <= 0 || height <= 0) {
			setRelationArrowVisibility(false);
			return false;
		}

		relationArrow.setAttribute("viewBox", `0 0 ${width} ${height}`);
		relationArrow.setAttribute("width", width);
		relationArrow.setAttribute("height", height);

		relationArrowArc.setAttribute("stroke", colorToCss(color));
		relationArrowArc.setAttribute("stroke-width", 0);
		relationArrowArc.style.fill = colorToCss(color);
		relationArrowArcOutline.setAttribute("stroke", colorToCss(outlineColor));
		relationArrowArcOutline.setAttribute("stroke-width", APP_CONFIG.runtime.visual.relations.arcOutlineWidth);
		relationArrowArcOutline.style.fill = colorToCss(color);

		relationArrowArc.setAttribute("d", arrowPath);
		relationArrowArcOutline.setAttribute("d", arrowPath);
		setRelationArrowVisibility(true);

		return true;
	}

	function update() {
		updatePopupPosition();
		updateTooltipPosition();
		updateRelationArrow();
		updateRelationTooltipPosition();
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
		updateRelationMarker();
	}

	function showTooltip(marker) {
		if (!marker) {
			hideTooltip();

			return;
		}

		activeTooltipMarker = marker;
		markerTooltip.textContent = markerName(marker);
		markerTooltip.hidden = false;
		updateTooltipPosition();
		updateRelationMarker();
	}

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
