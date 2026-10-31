import { t } from "../i18n.js";

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function floorLabel(index) {
	return t("floorLabel", {floor: index + 1});
}

function rangeLabel(minTick, maxTick) {
	if (maxTick - minTick === 1) {
		return floorLabel(minTick);
	}

	return t("floorRange", {
		min: floorLabel(minTick),
		max: floorLabel(maxTick - 1),
	});
}

function floorSelection(layers, minTick, maxTick) {
	if (minTick === 0 && maxTick === layers.length) {
		return null;
	}

	return {
		floorRange: [minTick, maxTick],
	};
}

function cssPixels(element, property, defaultValue) {
	const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));

	return Number.isFinite(value) ? value : defaultValue;
}

export function createFloorController({root, onChange}) {
	const track = document.createElement("div");
	const selection = document.createElement("div");
	const minHandle = document.createElement("button");
	const maxHandle = document.createElement("button");
	const minLabel = document.createElement("div");
	const maxLabel = document.createElement("div");
	let layers = [];
	let ticks = [];
	let minTick = 0;
	let maxTick = 0;
	let drag = null;
	let pendingEmit = false;

	track.className = "floor-control-track";
	selection.className = "floor-control-selection";
	minHandle.className = "floor-control-handle floor-control-handle-min";
	maxHandle.className = "floor-control-handle floor-control-handle-max";
	minLabel.className = "floor-control-label floor-control-label-min";
	maxLabel.className = "floor-control-label floor-control-label-max";
	minHandle.type = "button";
	maxHandle.type = "button";
	minHandle.setAttribute("aria-label", t("floorMinimum"));
	maxHandle.setAttribute("aria-label", t("floorMaximum"));
	track.append(selection, minHandle, maxHandle, minLabel, maxLabel);
	root.replaceChildren(track);

	function tickRatio(tick) {
		return layers.length > 0 ? tick / layers.length : 0;
	}

	function tickFromClientY(clientY) {
		const bounds = track.getBoundingClientRect();
		const ratio = bounds.height > 0
			? clamp(1 - (clientY - bounds.top) / bounds.height, 0, 1)
			: 0;

		return Math.round(ratio * layers.length);
	}

	function emitChange() {
		pendingEmit = false;
		onChange(floorSelection(layers, minTick, maxTick));
	}

	function updateTrackHeight() {
		if (layers.length === 0) {
			return;
		}

		const intervalHeight = cssPixels(root, "--floor-step", 52);
		const bottomGap = cssPixels(root, "--floor-bottom-gap", 124);
		const top = root.getBoundingClientRect().top;
		const naturalHeight = layers.length * intervalHeight;
		const availableHeight = Math.max(0, window.innerHeight - top - bottomGap);

		track.style.setProperty("--floor-track-height", `${Math.min(naturalHeight, availableHeight)}px`);
	}

	function setTickPosition(element, tick) {
		element.style.bottom = `${tickRatio(tick) * 100}%`;
	}

	function renderTicks() {
		for (const tick of ticks) {
			tick.remove();
		}

		ticks = [];
		track.style.setProperty("--floor-intervals", String(layers.length));

		for (let tickIndex = 0; tickIndex <= layers.length; tickIndex++) {
			const tick = document.createElement("div");

			tick.className = "floor-control-tick";
			setTickPosition(tick, tickIndex);
			track.append(tick);
			ticks.push(tick);
		}
	}

	function render() {
		if (layers.length <= 1) {
			root.hidden = true;
			return;
		}

		root.hidden = false;
		updateTrackHeight();

		const minText = floorLabel(minTick);
		const maxText = floorLabel(maxTick - 1);
		const title = minTick === 0 && maxTick === layers.length
			? t("floorRangeAll")
			: rangeLabel(minTick, maxTick);
		const minRatio = tickRatio(minTick) * 100;
		const maxRatio = tickRatio(maxTick) * 100;

		minLabel.textContent = minText;
		maxLabel.textContent = maxText;
		maxLabel.hidden = maxTick - minTick === 1;
		minHandle.title = minText;
		maxHandle.title = maxText;
		selection.title = title;
		minHandle.setAttribute("aria-valuetext", minText);
		maxHandle.setAttribute("aria-valuetext", maxText);
		setTickPosition(minHandle, minTick);
		setTickPosition(maxHandle, maxTick);
		setTickPosition(minLabel, minTick + 0.5);
		setTickPosition(maxLabel, maxTick - 0.5);
		selection.style.bottom = `${minRatio}%`;
		selection.style.top = `${100 - maxRatio}%`;
	}

	function scheduleEmit() {
		if (pendingEmit) {
			return;
		}

		pendingEmit = true;
		requestAnimationFrame(emitChange);
	}

	function setSelectionRange(nextMinTick, nextMaxTick) {
		const min = clamp(nextMinTick, 0, layers.length - 1);
		const max = clamp(nextMaxTick, min + 1, layers.length);

		if (minTick === min && maxTick === max) {
			return;
		}

		minTick = min;
		maxTick = max;
		render();
		scheduleEmit();
	}

	function startDrag(type, event) {
		if (layers.length <= 1) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		drag = {
			type,
			startTick: tickFromClientY(event.clientY),
			startMinTick: minTick,
			startMaxTick: maxTick,
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", stopDrag, {once: true});
		window.addEventListener("pointercancel", stopDrag, {once: true});
	}

	function onPointerMove(event) {
		if (!drag) {
			return;
		}

		const nextTick = tickFromClientY(event.clientY);

		if (drag.type === "min") {
			setSelectionRange(Math.min(nextTick, maxTick - 1), maxTick);
			return;
		}

		if (drag.type === "max") {
			setSelectionRange(minTick, Math.max(nextTick, minTick + 1));
			return;
		}

		const span = drag.startMaxTick - drag.startMinTick;
		const delta = nextTick - drag.startTick;
		const nextMinTick = clamp(drag.startMinTick + delta, 0, layers.length - span);

		setSelectionRange(nextMinTick, nextMinTick + span);
	}

	function stopDrag() {
		drag = null;
		window.removeEventListener("pointermove", onPointerMove);
		scheduleEmit();
	}

	minHandle.addEventListener("pointerdown", (event) => startDrag("min", event));
	maxHandle.addEventListener("pointerdown", (event) => startDrag("max", event));
	selection.addEventListener("pointerdown", (event) => startDrag("range", event));
	track.addEventListener("pointerdown", (event) => {
		if (event.target !== track && !event.target.classList.contains("floor-control-tick")) {
			return;
		}

		const tick = tickFromClientY(event.clientY);

		if (Math.abs(tick - minTick) <= Math.abs(tick - maxTick)) {
			setSelectionRange(Math.min(tick, maxTick - 1), maxTick);
			startDrag("min", event);
		} else {
			setSelectionRange(minTick, Math.max(tick, minTick + 1));
			startDrag("max", event);
		}
	});

	function setMap(map) {
		layers = map?.floorSlices?.layers ?? [];
		minTick = 0;
		maxTick = layers.length;
		renderTicks();
		render();
		onChange(null);
	}

	function onResize() {
		updateTrackHeight();
	}

	window.addEventListener("resize", onResize);
	window.visualViewport?.addEventListener("resize", onResize);

	return {
		setMap,
	};
}
