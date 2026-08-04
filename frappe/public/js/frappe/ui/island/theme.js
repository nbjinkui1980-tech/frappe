// Desk's live theme, shared by every island on the page.
//
// Desk flips `data-theme` on <html> mid-session (theme switcher, or the OS
// preference under "automatic"). One observer serves all islands.

const listeners = new Set();
let observer = null;

export function current_theme() {
	return document.documentElement.getAttribute("data-theme") || "light";
}

/** Run `callback(theme)` on every desk theme change. Returns an unsubscribe. */
export function on_theme_change(callback) {
	listeners.add(callback);

	if (!observer) {
		observer = new MutationObserver(() => {
			const theme = current_theme();
			listeners.forEach((listener) => listener(theme));
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
	}

	return () => {
		listeners.delete(callback);
		if (!listeners.size && observer) {
			observer.disconnect();
			observer = null;
		}
	};
}
