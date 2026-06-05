const AUTO_DISMISS_MS = 3000;

const NOTIFICATION_LEVELS = new Set(["info", "warning", "error"]);

function assertLevel(level) {
	if (!NOTIFICATION_LEVELS.has(level)) {
		throw new Error(`Unknown notification level: ${level}.`);
	}
}

export function createNotifications({container, createIcon, dismissLabel}) {
	function dismiss(element) {
		element.remove();
	}

	function show(level, message) {
		assertLevel(level);

		const element = document.createElement("div");
		const text = document.createElement("span");
		const close = document.createElement("button");

		element.className = `notification notification-${level}`;
		element.setAttribute("role", level === "error" ? "alert" : "status");

		text.textContent = message;

		close.className = "notification-close";
		close.type = "button";
		close.setAttribute("aria-label", dismissLabel());
		close.title = dismissLabel();
		close.append(createIcon());
		close.addEventListener("click", () => dismiss(element));

		element.append(text, close);
		container.append(element);

		if (level !== "error") {
			window.setTimeout(() => dismiss(element), AUTO_DISMISS_MS);
		}
	}

	return {
		info: (message) => show("info", message),
		warning: (message) => show("warning", message),
		error: (error) => {
			console.error(error);
			show("error", error.message);
		},
	};
}
