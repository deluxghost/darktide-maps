import { APP_CONFIG } from "./config.js";

const FALLBACK_MAX_OFFSET = 26;
const CONTROLS = APP_CONFIG.runtime.controls;

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

export function createRotationControl({root, handle, mapRenderer}) {
	let activePointerId = null;
	let animationFrame = null;
	let vector = [0, 0];

	function maxOffset() {
		const value = Number.parseFloat(getComputedStyle(root).getPropertyValue("--rotation-control-max-offset"));

		return Number.isFinite(value) ? value : FALLBACK_MAX_OFFSET;
	}

	function setHandlePosition(x, y) {
		handle.style.transform = `translate(${x}px, ${y}px)`;
	}

	function stopAnimation() {
		if (animationFrame !== null) {
			cancelAnimationFrame(animationFrame);
			animationFrame = null;
		}
	}

	function tick() {
		mapRenderer.rotateBy({
			rotationOrbit: vector[0] * CONTROLS.joystickOrbitDegreesPerFrame,
			rotationX: vector[1] * CONTROLS.joystickPitchDegreesPerFrame,
		});
		animationFrame = requestAnimationFrame(tick);
	}

	function startAnimation() {
		if (animationFrame === null) {
			animationFrame = requestAnimationFrame(tick);
		}
	}

	function updatePointer(pointer) {
		const bounds = root.getBoundingClientRect();
		const limit = maxOffset();
		const centerX = bounds.left + bounds.width / 2;
		const centerY = bounds.top + bounds.height / 2;
		const rawX = pointer.clientX - centerX;
		const rawY = pointer.clientY - centerY;
		const distance = Math.hypot(rawX, rawY);
		const scale = distance > limit ? limit / distance : 1;
		const x = rawX * scale;
		const y = rawY * scale;

		vector = [
			clamp(x / limit, -1, 1),
			clamp(y / limit, -1, 1),
		];
		setHandlePosition(x, y);
	}

	function reset() {
		activePointerId = null;
		vector = [0, 0];
		setHandlePosition(0, 0);
		stopAnimation();
		mapRenderer.clearRotationAnchor();
	}

	root.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		activePointerId = event.pointerId;
		root.setPointerCapture(event.pointerId);
		mapRenderer.clearRotationAnchor();
		updatePointer(event);
		startAnimation();
	});

	root.addEventListener("pointermove", (event) => {
		if (event.pointerId !== activePointerId) {
			return;
		}

		event.preventDefault();
		updatePointer(event);
	});

	root.addEventListener("pointerup", (event) => {
		if (event.pointerId === activePointerId) {
			reset();
		}
	});

	root.addEventListener("pointercancel", (event) => {
		if (event.pointerId === activePointerId) {
			reset();
		}
	});

	root.addEventListener("lostpointercapture", reset);
}
