export function initializeDialog(id) {
	const dialog = document.querySelector(`#${id}-dialog`);
	document.querySelector(`#${id}-toggle`).addEventListener("click", () => dialog.showModal());
	document.querySelector(`#${id}-close`).addEventListener("click", () => dialog.close());
	dialog.addEventListener("click", (event) => {
		if (event.target !== dialog) return;
		const bounds = dialog.getBoundingClientRect();
		if (event.clientX < bounds.left || event.clientX >= bounds.right
			|| event.clientY < bounds.top || event.clientY >= bounds.bottom) dialog.close();
	});
}
