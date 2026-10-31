import { localizeValue } from "../i18n.js";
import { APP_CONFIG } from "../config.js";
import { markerLinkGeometry, markerLinkOverlap } from "./link_geometry.js";
import { createMarkerLinkCanvas } from "./link_canvas.js";
import { boxesOverlap, visibleMarkerPoints, spreadTooltipLabels } from "./layout.js";

const PIN_BELLY_CENTER_FROM_TIP = 1 - 12.8 / 36;

export function createMarkerOverlays({
	markerPopup, markerPopupTitle, markerPopupType, markerPopupDescription,
	markerTooltip, auxiliaryArrow, mapRenderer, categoryTitle, markerName,
	onCopyMarkerUrl, onCopyMarkerUrlError,
}) {
	let activeMarker = null;
	let activeTooltipMarker = null;
	const relatedTooltips = [];
	const arrowCache = new Map();
	let arrowView = null;
	const paintArrows = createMarkerLinkCanvas(auxiliaryArrow, APP_CONFIG.runtime.visual.auxiliaryLinks.arcOutlineWidth);
	const pins = APP_CONFIG.runtime.visual.pins;
	const links = APP_CONFIG.runtime.visual.auxiliaryLinks;
	const textSizes = new Map();
	const measure = document.createElement("div");
	measure.className = "marker-tooltip";
	measure.setAttribute("aria-hidden", "true");
	Object.assign(measure.style, {visibility: "hidden", left: "0", top: "0", transform: "none"});
	markerTooltip.parentElement.append(measure);
	const mapPanel = document.querySelector("#panel");
	const floorControl = document.querySelector("#floor-control");

	function isAuxiliary(marker) {
		return marker?.markerType === "auxiliary_pin" && marker.parentMarker;
	}

	function pinScale(marker) {
		return isAuxiliary(marker) ? links.auxiliaryPinScale : 1;
	}

	function markerColor(marker) {
		return pins.categories[marker.category].color;
	}

	function linkedOwners() {
		const hovered = isAuxiliary(activeTooltipMarker) ? activeTooltipMarker.parentMarker : activeTooltipMarker;
		return [...new Map([activeMarker, hovered].filter(Boolean).map((marker) => [marker.id, marker])).values()];
	}

	function markerLinks(owner) {
		if (!owner) return [];
		const auxiliaries = (owner.auxiliaryMarkers ?? []).map((marker) => {
			const auxiliary = {...marker, category: marker.category ?? owner.category,
				markerType: "auxiliary_pin", parentMarker: owner};
			return {from: marker.direction === "to_parent" ? auxiliary : owner,
				to: marker.direction === "to_parent" ? owner : auxiliary, color: markerColor(auxiliary)};
		});
		const peers = mapRenderer.markerRelations(owner).map((relation) => ({
			...relation,
			color: markerColor(relation.from.id === owner.id ? relation.to : relation.from),
		}));
		return [...auxiliaries, ...peers];
	}

	function tooltipSize(text, maximumWidth) {
		const key = `${maximumWidth}|${text}`;
		if (!textSizes.has(key)) {
			measure.style.maxWidth = `${maximumWidth}px`;
			measure.textContent = text;
			const {width, height} = measure.getBoundingClientRect();
			textSizes.set(key, {width, height});
		}
		return textSizes.get(key);
	}

	function paintTooltip(element, label) {
		element.hidden = !label;
		if (!label) return;
		if (element.textContent !== label.text) element.textContent = label.text;
		element.style.maxWidth = `${label.maximumWidth}px`;
		element.style.left = `${label.left}px`;
		element.style.top = `${label.top + label.height / 2}px`;
		element.classList.toggle("tooltip-side-left", label.side === "left");
		element.classList.toggle("tooltip-side-right", label.side === "right");
	}

	function updateTooltips(frame, relations, geometries, owners) {
		const {bounds, points, tooltipPoints} = frame;
		const maximumWidth = Math.min(links.tooltipMaxWidth,
			(bounds.width - pins.iconWidth - 2 * (links.tooltipOffset[0] + links.tooltipViewportPadding)) / 2);
		const balances = new Map();
		const linkedIds = new Set();
		for (const {from, to} of relations) {
			const start = points.get(from.id), end = points.get(to.id);
			balances.set(from.id, (balances.get(from.id) ?? 0) + (end.x >= start.x ? 1 : -1));
			balances.set(to.id, (balances.get(to.id) ?? 0) + (start.x >= end.x ? 1 : -1));
			linkedIds.add(from.id); linkedIds.add(to.id);
		}
		const occupied = frame.occupied;
		function place(point, primary = false) {
			const text = markerName(point.marker), size = tooltipSize(text, maximumWidth);
			const linked = linkedIds.has(point.marker.id);
			const [offsetX, offsetY] = linked ? [point.width / 2 + links.tooltipOffset[0], links.tooltipOffset[1]] : pins.tooltipOffset;
			const anchorY = linked ? point.y : point.tipY;
			const top = Math.max(bounds.top + links.tooltipViewportPadding,
				Math.min(anchorY + offsetY - size.height / 2, bounds.bottom - size.height - links.tooltipViewportPadding));
			const preferred = (balances.get(point.marker.id) ?? 0) > 0 ? "left" : "right";
			const choices = [preferred, preferred === "left" ? "right" : "left"].map((side) => {
				const left = side === "left" ? point.x - offsetX - size.width : point.x + offsetX;
				const rect = {left, top, right: left + size.width, bottom: top + size.height};
				return {...rect, ...size, side, text, maximumWidth, overlap: markerLinkOverlap(geometries, rect)};
			}).filter((label) => label.left >= bounds.left + links.tooltipViewportPadding
				&& label.right <= bounds.right - links.tooltipViewportPadding)
				.sort((left, right) => left.overlap - right.overlap);
			const best = choices[0];
			if (!best) return null;
			if (primary) return best;
			const label = choices.find((candidate) => candidate.overlap <= best.overlap
				&& !occupied.some((rect) => boxesOverlap(candidate, rect)));
			if (label) occupied.push(label);
			return label;
		}
		const primary = activeTooltipMarker?.id !== activeMarker?.id && tooltipPoints.get(activeTooltipMarker?.id);
		const primaryLabel = primary ? place(primary, true) : null;
		paintTooltip(markerTooltip, primaryLabel);
		if (primaryLabel) occupied.push(primaryLabel);
		const candidates = [...tooltipPoints.values()].filter((point) => linkedIds.has(point.marker.id)
			&& point.marker.id !== activeTooltipMarker?.id && point.marker.id !== activeMarker?.id);
		const anchors = [...owners.map((owner) => points.get(owner.id)), primary].filter(Boolean);
		const limit = links.tooltipMaxCount - Number(Boolean(primaryLabel));
		const labels = candidates.length ? spreadTooltipLabels(candidates, anchors, place, limit) : [];
		while (relatedTooltips.length < labels.length) {
			const element = document.createElement("div");
			element.className = "marker-tooltip auxiliary-tooltip";
			markerTooltip.parentElement.append(element);
			relatedTooltips.push(element);
		}
		while (relatedTooltips.length > labels.length) relatedTooltips.pop().remove();
		labels.forEach((label, index) => paintTooltip(relatedTooltips[index], label));
	}

	function updateArrows(relations, frame) {
		let offset = {x: 0, y: 0};
		if (relations.length) {
			const anchor = frame.points.get(relations[0].from.id);
			const key = `${anchor.marker.id}|${frame.viewKey}`;
			if (arrowView?.key !== key) arrowView = {key, x: anchor.x, y: anchor.y};
			offset = {x: anchor.x - arrowView.x, y: anchor.y - arrowView.y};
		} else {
			arrowView = null;
		}
		const geometries = [];
		const arrows = [];
		const activeKeys = new Set();
		relations.forEach(({from, to, color}) => {
			const key = `${from.id}|${to.id}`;
			activeKeys.add(key);
			let arrow = arrowCache.get(key);
			if (!arrow) {
				arrow = {};
				arrowCache.set(key, arrow);
			}
			if (arrow.viewKey !== arrowView.key) {
				const start = frame.points.get(from.id), end = frame.points.get(to.id);
				arrow.geometry = markerLinkGeometry({
					start: {x: start.x - offset.x, y: start.y - offset.y},
					end: {x: end.x - offset.x, y: end.y - offset.y},
				}, {startScale: pinScale(from), endScale: pinScale(to)});
				arrow.viewKey = arrowView.key;
			}
			const geometry = arrow.geometry;
			if (!geometry) return;
			geometries.push(geometry);
			arrows.push(arrow);
			arrow.color = color;
		});
		for (const key of arrowCache.keys()) {
			if (activeKeys.has(key)) continue;
			arrowCache.delete(key);
		}
		if (frame) paintArrows(arrows, offset, frame.bounds);
		else {
			auxiliaryArrow.style.visibility = "hidden";
			auxiliaryArrow.dataset.arrowCount = "0";
		}
		return {shapes: geometries, offset};
	}

	function occupiedBounds() {
		return [mapPanel, floorControl].filter((element) => element && !element.hidden)
			.map((element) => element.getBoundingClientRect());
	}

	function update() {
		const owners = linkedOwners();
		// Hover wins shared links without replacing unrelated popup links.
		const relations = [...new Map(owners.flatMap(markerLinks)
			.map((relation) => [`${relation.from.id}|${relation.to.id}`, relation])).values()];
		mapRenderer.setAuxiliaryMarkerOwners(owners.filter((owner) => owner.auxiliaryMarkers?.length));
		const markers = new Map(relations.flatMap(({from, to}) => [[from.id, from], [to.id, to]]));
		if (activeTooltipMarker) markers.set(activeTooltipMarker.id, activeTooltipMarker);
		const popupOnly = activeMarker && !markers.has(activeMarker.id);
		const projection = markers.size || activeMarker
			? mapRenderer.projectMarkers([...markers.values(), ...(popupOnly ? [activeMarker] : [])]) : null;
		if (!projection) {
			paintTooltip(markerTooltip, null);
			while (relatedTooltips.length) relatedTooltips.pop().remove();
			updateArrows([], null);
			return;
		}
		const projected = projection.points.filter((point) => !popupOnly || point.marker !== activeMarker).map((point) => {
			const width = pins.iconWidth * pinScale(point.marker), height = pins.iconHeight * pinScale(point.marker);
			return {...point, tipY: point.y, y: point.y - height * PIN_BELLY_CENTER_FROM_TIP, width, height};
		});
		const forcedIds = new Set([...owners.map((owner) => owner.id), activeMarker?.id, activeTooltipMarker?.id]);
		const tooltipPoints = visibleMarkerPoints(projected, projection.bounds, forcedIds);
		const points = new Map(projected.map((point) => [point.marker.id, point]));
		const frame = {bounds: projection.bounds, viewKey: projection.viewKey, points, tooltipPoints, occupied: occupiedBounds()};
		if (activeMarker) {
			const point = projection.points.find((point) => point.marker.id === activeMarker.id);
			markerPopup.style.left = `${point.x}px`;
			markerPopup.style.top = `${point.y}px`;
			frame.occupied.push(markerPopup.getBoundingClientRect());
		}
		const arrows = updateArrows(relations, frame);
		updateTooltips(frame, relations, arrows, owners);
	}

	function hidePopup() {
		activeMarker = null;
		markerPopup.hidden = true;
		update();
	}

	function hideTooltip() {
		activeTooltipMarker = null;
		update();
	}

	function showPopup(marker) {
		if (!marker) return hidePopup();
		activeMarker = marker;
		markerPopupTitle.textContent = markerName(marker);
		markerPopupType.textContent = categoryTitle(marker.category);
		markerPopupDescription.hidden = !marker.description;
		markerPopupDescription.textContent = marker.description ? localizeValue(marker.description, "") : "";
		markerPopup.hidden = false;
		update();
	}

	function showTooltip(marker) {
		activeTooltipMarker = marker;
		update();
	}

	markerPopupTitle.addEventListener("click", () => {
		if (onCopyMarkerUrl && activeMarker) onCopyMarkerUrl(activeMarker).catch(onCopyMarkerUrlError);
	});

	function hideForCategory(category) {
		if (activeMarker?.category === category) hidePopup();
		if (!isAuxiliary(activeTooltipMarker) && activeTooltipMarker?.category === category) hideTooltip();
	}

	return {hidePopup, hideTooltip, hideForCategory, showPopup, showTooltip, update};
}
