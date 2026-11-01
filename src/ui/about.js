import changelog from "../../config/changelog.json";
import { localizeValue } from "../i18n.js";
import { initializeDialog } from "./dialog.js";

export function initializeAbout() {
	initializeDialog("about");
	renderChangelog();
}

export function renderChangelog() {
	const entries = document.querySelector("#changelog-entries");
	entries.replaceChildren();
	for (const entry of changelog) {
		const section = document.createElement("section");
		const heading = document.createElement("h3");
		heading.textContent = entry.date;
		const list = document.createElement("ul");
		for (const text of entry.items) {
			const item = document.createElement("li");
			item.textContent = localizeValue(text);
			list.append(item);
		}
		section.append(heading, list);
		entries.append(section);
	}
}
