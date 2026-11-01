import translations from "./translations.json";
import { resolveLanguage } from "./languages.js";

const queryLanguage = new URLSearchParams(window.location.search).get("l");
const browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language];

export const language = resolveLanguage("auto", queryLanguage, browserLanguages);
let gameText = new Map();

export async function loadGameText(url, markerLabels) {
	if (typeof url !== "string" || !url) throw new Error("Missing game text resource");
	if (!markerLabels || typeof markerLabels !== "object" || Array.isArray(markerLabels)) {
		throw new Error("Missing game marker label definitions");
	}
	const response = await fetch(url);
	if (!response.ok) throw new Error(t("errorLoadingGameText", {status: response.status}));
	const entries = await response.json();
	const selected = new Map();
	for (const [key, value] of Object.entries(entries)) {
		if (!value || typeof value.en !== "string" || Object.values(value).some(text => typeof text !== "string")) {
			throw new Error(`Invalid game text: ${key}`);
		}
		selected.set(key, value);
	}
	for (const [key, reference] of Object.entries(markerLabels)) {
		if (!key.startsWith("loc_") || selected.has(key) || !selected.has(reference?.gameText)) {
			throw new Error(`Invalid game marker label: ${key}`);
		}
		selected.set(key, selected.get(reference.gameText));
	}
	gameText = selected;
}

function gameTextValue(key, locale) {
	if (!gameText.has(key)) throw new Error(`Unknown game text: ${key}`);
	const text = gameText.get(key);
	return text[locale] ?? text.en;
}

export function localizeValue(value, fallback, locale = language) {
	if (typeof value === "string") {
		return value;
	}

	if (!value || typeof value !== "object") {
		return fallback;
	}

	if (value.key) {
		return t(value.key, value.values ?? {}, locale);
	}
	if (Object.hasOwn(value, "gameText")) {
		return gameTextValue(value.gameText, locale);
	}

	return value[locale]
		?? value.en
		?? fallback;
}

export function t(key, values = {}, locale = language) {
	const template = key.startsWith("loc_")
		? gameTextValue(key, locale)
		: translations[locale][key] ?? translations.en[key] ?? key;

	return template.replace(/\{([^}]+)\}/g, (_, name) => values[name] ?? "");
}

export function applyTranslations(root = document) {
	document.documentElement.lang = new Intl.Locale(language).baseName;
	for (const element of root.querySelectorAll("[data-i18n]")) {
		element.textContent = t(element.dataset.i18n);
	}

	for (const element of root.querySelectorAll("[data-i18n-html]")) {
		element.innerHTML = t(element.dataset.i18nHtml);
	}

	for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
		element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
	}

	for (const element of root.querySelectorAll("[data-i18n-title]")) {
		element.title = t(element.dataset.i18nTitle);
	}
}
