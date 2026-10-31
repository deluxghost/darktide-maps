import changelog from "../../config/changelog.json";
import { localizeValue } from "../i18n.js";

export function initializeAbout() {
	const dialog = document.querySelector("#about-dialog");
	const entries = document.querySelector("#changelog-entries");
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
	document.querySelector("#about-toggle").addEventListener("click", () => dialog.showModal());
	document.querySelector("#about-close").addEventListener("click", () => dialog.close());
	dialog.addEventListener("close", () => {
		document.querySelector("#debug-panel").hidden = true;
		document.querySelector("#debug-toggle").setAttribute("aria-expanded", "false");
	});
}
