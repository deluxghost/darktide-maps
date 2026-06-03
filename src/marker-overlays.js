import { localizeValue } from "./i18n.js";
import { APP_CONFIG } from "./config.js";

export function createMarkerOverlays({
	markerPopup,
	markerPopupTitle,
	markerPopupType,
	markerPopupDescription,
	markerTooltip,
	mapRenderer,
	categoryTitle,
	markerName,
}) {
	let activeMarker = null;
	let activeTooltipMarker = null;

	function hidePopup() {
		activeMarker = null;
		markerPopup.hidden = true;
	}

	function hideTooltip() {
		activeTooltipMarker = null;
		markerTooltip.hidden = true;
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

		markerTooltip.style.left = `${point.x + offsetX}px`;
		markerTooltip.style.top = `${point.y + offsetY}px`;
	}

	function update() {
		updatePopupPosition();
		updateTooltipPosition();
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
