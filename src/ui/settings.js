import { getLanguagePreference, setLanguagePreference, t } from "../i18n.js";
import { locales } from "../languages.js";
import { initializeDialog } from "./dialog.js";

export function initializeSettings(onChange) {
	initializeDialog("settings");
	const debugGroup = document.querySelector('[data-settings-group="debug"]');
	if (import.meta.env.DEV) debugGroup.hidden = false;
	else debugGroup.remove();
	const select = document.querySelector("#language-select");
	// Keep endonym ordering stable when the interface language changes.
	const order = new Intl.Collator("en", {sensitivity: "base"});
	const languages = Object.entries(locales).sort(([, a], [, b]) => order.compare(a.name, b.name));
	function refresh() {
		select.replaceChildren(new Option(t("languageAuto"), "auto"));
		for (const [id, locale] of languages) {
			const label = locale.machineTranslated
				? t("machineTranslatedLanguage", {name: locale.name}) : locale.name;
			const option = new Option(label, id);
			option.lang = new Intl.Locale(id).baseName;
			select.append(option);
		}
		select.value = getLanguagePreference();
	}
	select.addEventListener("change", () => {
		setLanguagePreference(select.value);
		onChange();
		refresh();
	});
	refresh();
}
