export const locales = {
	de: {name: "Deutsch", machineTranslated: true},
	en: {name: "English", machineTranslated: false},
	es: {name: "Español", machineTranslated: true},
	fr: {name: "Français", machineTranslated: true},
	it: {name: "Italiano", machineTranslated: true},
	ja: {name: "日本語", machineTranslated: true},
	ko: {name: "한국어", machineTranslated: true},
	pl: {name: "Polski", machineTranslated: true},
	"pt-br": {name: "Português (Brasil)", machineTranslated: true},
	ru: {name: "Русский", machineTranslated: true},
	"zh-cn": {name: "简体中文", machineTranslated: false},
	"zh-tw": {name: "繁體中文", machineTranslated: true},
};

const supported = Object.keys(locales).map((id) => ({id, locale: new Intl.Locale(id).maximize()}));

function matchLanguage(tag) {
	let locale;
	try {
		locale = new Intl.Locale(tag).maximize();
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		return null;
	}
	return supported.find((candidate) => candidate.locale.language === locale.language
		&& candidate.locale.script === locale.script)?.id ?? null;
}

export function resolveLanguage(preference, query, browserLanguages) {
	const requested = query ?? preference;
	for (const tag of requested === "auto" ? browserLanguages : [requested]) {
		const match = matchLanguage(tag);
		if (match) return match;
	}
	return "en";
}
