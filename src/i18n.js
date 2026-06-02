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
		aliasedLocale,
		locale,
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

	for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
		element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
	}
}
