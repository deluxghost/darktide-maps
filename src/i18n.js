const translations = {
	en: {
		appTitle: "Darktide Maps",
		dismiss: "Dismiss",
		errorLoadingManifest: "HTTP {status} while loading map manifest.",
		errorNoMaps: "Map manifest contains no maps.",
		filterMainPath: "Main Path",
		filters: "Filters",
		helpDesktop: "Drag to pan. Right-drag or Shift + drag to rotate. Scroll to zoom.",
		helpMobile: "Drag to pan. Pinch to zoom. Twist or use three fingers to rotate.",
		loadingMap: "Loading {title} ({size})...",
		map: "Map",
		noMarkerCategories: "No marker categories available.",
		toggleMenu: "Toggle menu",
	},
	zh: {
		appTitle: "Darktide Maps",
		dismiss: "关闭",
		errorLoadingManifest: "加载地图清单时返回 HTTP {status}。",
		errorNoMaps: "地图清单中没有地图。",
		filterMainPath: "主路径",
		filters: "筛选",
		helpDesktop: "拖动平移。右键拖动或 Shift + 拖动旋转。滚轮缩放。",
		helpMobile: "拖动平移。双指缩放。双指旋转或三指旋转地图。",
		loadingMap: "正在加载 {title}（{size}）...",
		map: "地图",
		noMarkerCategories: "没有可用的地标分类。",
		toggleMenu: "切换菜单",
	},
};

const language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";

export function t(key, values = {}) {
	const template = translations[language][key] ?? translations.en[key] ?? key;

	return template.replace(/\{([^}]+)\}/g, (_, name) => values[name] ?? "");
}

export function applyTranslations(root = document) {
	for (const element of root.querySelectorAll("[data-i18n]")) {
		element.textContent = t(element.dataset.i18n);
	}

	for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
		element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
	}
}
