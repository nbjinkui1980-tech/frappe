/**
 * frappe.ui.mount_vue_island — the island shell. An island module implements the
 * mount envelope on top of it:
 *
 *     import App from "./App.vue";
 *     export const mount = (el, context) =>
 *         frappe.ui.mount_vue_island(el, { ...context, component: App });
 *
 * Isolation is Shadow DOM: the boundary encapsulates CSS both ways, so frappe-ui
 * ships its normal preflight and nothing leaks into or out of Bootstrap-owned
 * desk DOM.
 */

import { current_theme, on_theme_change } from "./theme.js";

const RUNTIME_CSS_KEY = "island_runtime.css";

// Desk's modal tier (Bootstrap's `.modal`), which is where an island's dialogs
// and popovers belong: above every page-level control desk paints — the icon
// rail at 1020, menus and dropdowns at 1030 — and level with a desk dialog.
const ISLAND_OVERLAY_Z_INDEX = "1050";

// A global symbol, so the shell needs no static frappe-ui import — which it
// could not have anyway, living in a classic desk bundle.
const PORTAL_TARGET_KEY = Symbol.for("frappe-ui:portal-target");

// Ambient host context, for islands that would rather inject it than thread it
// down from their root component.
const HOST_KEY = Symbol.for("frappe:island-host");

// url -> Promise<CSSStyleSheet>. One sheet object per URL for the whole page,
// adopted into every shadow root: fetched once, parsed once, however many
// islands mount.
const style_sheets = new Map();

// target element -> handle, so a second mount into the same element replaces
// the first instead of stacking on it.
const mounted = new WeakMap();

/**
 * @typedef {Object} MountVueIslandOptions
 * @property {any} component            Vue component to render.
 * @property {Object} [host]            Ambient host context (framework-injected).
 * @property {Object} [props]           Props for the component.
 * @property {Object} [on]              Callbacks; `on.navigate` reaches the
 *                                      component as the `onNavigate` listener.
 * @property {string[]} [styles]        Stylesheet URLs to adopt after the
 *                                      runtime sheet (framework-injected).
 * @property {(app: any) => void} [configure]  Called with the Vue app before
 *                                      mount, for plugins and global components.
 * @property {Array} [routes]           vue-router routes; default none.
 */

/**
 * @param {HTMLElement|JQuery} el
 * @param {MountVueIslandOptions} options
 * @returns {Promise<{ app: any, shadow_root: ShadowRoot, update: (props: Object) => void, unmount: () => void }>}
 */
export async function mount_vue_island(el, options) {
	const {
		component,
		host = {},
		props = {},
		on = {},
		styles = [],
		configure,
		routes,
	} = options || {};

	const target = resolve_element(el);
	if (!component) {
		throw new Error("mount_vue_island: no component given");
	}

	mounted.get(target)?.unmount();

	const shadow_host = document.createElement("div");
	shadow_host.className = "frappe-island";
	target.appendChild(shadow_host);
	const shadow_root = shadow_host.attachShadow({ mode: "open" });

	// frappe-ui's dark selector is `[data-theme="dark"] .dark\:x`, a descendant
	// rule — so the attribute has to sit on an element inside the shadow root,
	// not on :host, which no descendant combinator can reach.
	const root = document.createElement("div");
	root.className = "frappe-island-root";

	// Overlays (Dialog, Popover, Select, …) portal here rather than to <body>,
	// so they render inside the styled, encapsulated tree. reka-ui resolves its
	// target as explicit prop > host inject > its own default, and an element
	// is the only form that survives the shadow boundary — a selector string
	// would be queried against the document and never match.
	const portal = document.createElement("div");
	portal.className = "frappe-island-portal";
	// A shadow root is not a stacking context, so an overlay inside it competes
	// with desk's chrome directly. At `z-index: auto` it loses to the icon rail
	// (1020) and desk's menus (1030) and gets painted under them, even though it
	// covers them for hit testing. The portal carries the tier instead of the
	// host, so only overlays are raised and the island's own content stays in
	// the page flow.
	portal.style.position = "relative";
	portal.style.zIndex = ISLAND_OVERLAY_Z_INDEX;

	shadow_root.append(root, portal);

	const apply_theme = (theme) => {
		root.setAttribute("data-theme", theme);
		portal.setAttribute("data-theme", theme);
	};
	apply_theme(current_theme());

	let stop_theme = null;
	try {
		return await build();
	} catch (e) {
		// The shadow host is in the page already, so a failed runtime fetch or a
		// throwing component would otherwise leave an empty island behind.
		stop_theme?.();
		shadow_host.remove();
		throw e;
	}

	async function build() {
		// The runtime sheet first, the island's own after it, so app styles win ties.
		shadow_root.adoptedStyleSheets = await Promise.all(
			[runtime_css_url(), ...styles].map(shared_style_sheet)
		);

		const { createApp, h, ref, shallowRef } = await import_module("vue");
		const { createRouter, createMemoryHistory } = await import_module("vue-router");

		const theme = ref(current_theme());
		stop_theme = on_theme_change((next) => {
			theme.value = next;
			apply_theme(next);
		});

		// The loader's `host.theme` reads the DOM, which is correct but not tracked.
		// Re-point it at a ref now that Vue is here, so a mid-session theme switch
		// re-renders the island.
		Object.defineProperty(host, "theme", {
			configurable: true,
			enumerable: true,
			get: () => theme.value,
		});

		const current_props = shallowRef({ ...props });
		const listeners = to_listeners(on);

		const app = createApp({
			name: "FrappeIsland",
			render: () => h(component, { ...current_props.value, ...listeners }),
		});

		// Desk globals, so components that call `__()` or read `frappe` work.
		window.SetVueGlobals?.(app);

		// frappe-ui components (Button, MultiSelect, …) call useRouter()
		// unconditionally. A memory router keeps that inject resolvable; an island
		// that wants navigation of its own passes real routes.
		app.use(createRouter({ history: createMemoryHistory(), routes: routes || [] }));

		app.provide(PORTAL_TARGET_KEY, portal);
		app.provide(HOST_KEY, host);

		configure?.(app);

		app.mount(root);

		let destroyed = false;
		const handle = {
			app,
			shadow_root,
			update(next) {
				if (destroyed) return;
				current_props.value = { ...current_props.value, ...next };
			},
			unmount() {
				if (destroyed) return;
				destroyed = true;
				stop_theme();
				try {
					app.unmount();
				} catch (e) {
					// Swallow: a failed unmount must not block teardown of the host.
					console.error("island: error during unmount", e);
				}
				// Dropping the host drops the shadow root and everything in it.
				shadow_host.remove();
				if (mounted.get(target) === handle) mounted.delete(target);
			},
		};

		mounted.set(target, handle);
		return handle;
	}
}

/** `{ navigate: fn }` -> `{ onNavigate: fn }`, the shape Vue emits into. */
function to_listeners(on) {
	return Object.fromEntries(
		Object.entries(on || {}).map(([event, handler]) => [
			`on${event.charAt(0).toUpperCase()}${event.slice(1)}`,
			handler,
		])
	);
}

function shared_style_sheet(url) {
	if (!style_sheets.has(url)) {
		const sheet = fetch(url)
			.then((response) => {
				if (!response.ok) {
					throw new Error(`island: cannot load ${url} (${response.status})`);
				}
				return response.text();
			})
			.then((css) => {
				const sheet = new CSSStyleSheet();
				sheet.replaceSync(css);
				return sheet;
			})
			.catch((e) => {
				// Don't let one failed fetch poison every later mount.
				style_sheets.delete(url);
				throw e;
			});
		style_sheets.set(url, sheet);
	}
	return style_sheets.get(url);
}

function runtime_css_url() {
	const url = frappe.boot?.assets_json?.[RUNTIME_CSS_KEY];
	if (!url) {
		throw new Error(
			`island: ${RUNTIME_CSS_KEY} is not in assets.json — build the island runtime (bench build --app frappe)`
		);
	}
	return url;
}

// esbuild bundles a dynamic import whose specifier is a literal, which would
// pull Vue into desk. Through a variable it stays a native import(), resolved
// by the page's import map.
function import_module(specifier) {
	return import(specifier);
}

function resolve_element(el) {
	const target = el && el.jquery ? el[0] : el;
	if (!target || !target.appendChild) {
		throw new Error("island: mount target is not an element");
	}
	return target;
}

frappe.provide("frappe.ui");
frappe.ui.mount_vue_island = mount_vue_island;
