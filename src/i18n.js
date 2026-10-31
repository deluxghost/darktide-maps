import translations from "./translations.json";

const queryLanguage = new URLSearchParams(window.location.search).get("l")?.toLowerCase();
const browserLanguages = (navigator.languages?.length ? navigator.languages : [navigator.language])
	.map((locale) => locale.toLowerCase());
const languageAliases = new Map([
	["zh", "zh-cn"],
]);

function expandLocale(locale) {
	const baseLocale = locale.split("-")[0];
	const aliasedLocale = languageAliases.get(locale) ?? languageAliases.get(baseLocale);

	return [
		locale,
		aliasedLocale,
		baseLocale,
	].filter(Boolean);
}

function selectLocale(availableLocales, fallbackLocale = "en") {
	const available = new Set(availableLocales.map((locale) => locale.toLowerCase()));
	const preferredLocales = queryLanguage
		? [queryLanguage, ...browserLanguages]
		: browserLanguages;

	for (const locale of preferredLocales) {
		for (const candidate of expandLocale(locale)) {
			if (available.has(candidate)) {
				return candidate;
			}
		}
	}

	return fallbackLocale;
}

export const language = selectLocale(Object.keys(translations));
let gameText = new Map();

export async function loadGameText(url) {
	if (typeof url !== "string" || !url) throw new Error("Missing game text resource");
	const response = await fetch(url);
	if (!response.ok) throw new Error(t("errorLoadingGameText", {status: response.status}));
	const entries = await response.json();
	const selected = new Map();
	for (const [key, value] of Object.entries(entries)) {
		if (!value || typeof value.en !== "string" || Object.values(value).some(text => typeof text !== "string")) {
			throw new Error(`Invalid game text: ${key}`);
		}
		selected.set(key, value[selectLocale(Object.keys(value))] ?? value.en);
	}
	gameText = selected;
}

export function localizeValue(value, fallback) {
	if (typeof value === "string") {
		return value;
	}

	if (!value || typeof value !== "object") {
		return fallback;
	}

	if (value.key) {
		return t(value.key, value.values ?? {});
	}
	if (Object.hasOwn(value, "gameText")) {
		if (!gameText.has(value.gameText)) throw new Error(`Unknown game text: ${value.gameText}`);
		return gameText.get(value.gameText);
	}

	const locale = selectLocale(Object.keys(value));

	return value[locale]
		?? value.en
		?? fallback;
}

export function t(key, values = {}) {
	const template = translations[language][key] ?? translations.en[key] ?? key;

	return template.replace(/\{([^}]+)\}/g, (_, name) => values[name] ?? "");
}

export function applyTranslations(root = document) {
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
