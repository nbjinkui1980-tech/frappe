/**
 * frappe.ui.mount_island — the one call desk makes to put an app's island on a
 * page.
 *
 *     const island = await frappe.ui.mount_island("insights.dashboard", el, {
 *         props: { dashboard: "sales" },
 *         on: { navigate: (intent) => frappe.set_route(intent.route) },
 *     });
 *     island.update({ filters });
 *     island.unmount();
 *
 * Resolution runs name -> the `ui_islands` registry (hooks, carried in boot) ->
 * assets.json -> dynamic `import()` -> the module's `mount`. An import map
 * applies to `import()` from a classic script too, so this file rides desk's
 * normal esbuild bundle and no `frappe.require` is involved.
 *
 * The caller passes `{ props, on }`; framework injects `host` and `styles`.
 */

import { current_theme } from "./theme.js";

const ISLAND_JS_SUFFIX = ".island.js";
const ISLAND_CSS_SUFFIX = ".island.css";

// target element -> { name, url, context, handle }. A Map rather than a
// WeakMap because hot_update has to walk what is live on the page.
const islands = new Map();

/**
 * @param {string} name        Island name as declared in an app's `ui_islands` hook.
 * @param {HTMLElement|JQuery} el
 * @param {{ props?: Object, on?: Object }} [context]
 * @returns {Promise<{ update: (props: Object) => void, unmount: () => void }>}
 */
async function mount_island(name, el, context = {}) {
	const target = el && el.jquery ? el[0] : el;
	const assets = resolve_island(name);

	const module = await import(assets.js);
	if (typeof module.mount !== "function") {
		throw new Error(`Island "${name}" (${assets.js}) does not export mount()`);
	}

	unmount_island(target);

	const handle = await module.mount(target, {
		host: build_host(),
		props: context.props || {},
		on: context.on || {},
		styles: assets.css ? [assets.css] : [],
	});

	const entry = { name, url: assets.js, context, handle };
	islands.set(target, entry);

	return {
		update: (props) => handle.update(props),
		unmount: () => {
			handle.unmount();
			if (islands.get(target) === entry) islands.delete(target);
		},
	};
}

/** Tear down whatever island is mounted in `target`. Safe to call any time. */
function unmount_island(target) {
	const entry = islands.get(target);
	if (!entry) return;
	islands.delete(target);
	entry.handle.unmount();
}

function resolve_island(name) {
	const bundle = frappe.boot?.ui_islands?.[name];
	if (!bundle) {
		throw new Error(
			`Island "${name}" is not declared. Add it to ui_islands in the app's hooks.py.`
		);
	}

	const assets_json = frappe.boot?.assets_json || {};
	const js = assets_json[bundle + ISLAND_JS_SUFFIX];
	if (!js) {
		throw new Error(
			`Island "${name}" points at bundle "${bundle}", but "${bundle}${ISLAND_JS_SUFFIX}" is not in assets.json. Build the app that ships it.`
		);
	}

	return { js, css: assets_json[bundle + ISLAND_CSS_SUFFIX] || null };
}

/**
 * The ambient context every island receives. The caller never assembles it, so
 * an island honors desk's theme, language and timezone with no per-island
 * wiring.
 */
function build_host() {
	const boot = frappe.boot || {};
	const host = {
		locale: boot.lang || "en",
		timezone: boot.time_zone?.user || boot.time_zone?.system || null,
		user: frappe.session?.user || boot.user?.name || null,
		base_url: frappe.urllib ? frappe.urllib.get_base_url() : window.location.origin,

		// Where the reader came from. An island that draws its own page header
		// needs a parent crumb in it, and desk's breadcrumbs are page-head markup
		// (`page.html`) that such a page does not draw — so the trail reaches the
		// island as data or it is lost. Ancestors only: the island's own page is
		// the island's to name.
		breadcrumbs: entry_breadcrumbs(),

		// Desk routing, which an island cannot do for itself: a click inside a
		// shadow root is retargeted to the island's host element, so desk's
		// anchor delegation never matches it and a plain link would reload the
		// whole page.
		navigate: (route) => frappe.set_route(route),

		// Naming the browser tab, for an island that is the whole page. Through
		// desk rather than by assigning `document.title`: desk keeps the unread
		// count as a title prefix over a remembered original, and an island
		// writing the title behind its back would have that original put back.
		set_title: (title) => frappe.utils.set_title(title),
	};

	// Live: desk flips the theme mid-session. Reading the DOM keeps this correct
	// for any consumer; the shell re-points it at a Vue ref so templates track it.
	Object.defineProperty(host, "theme", {
		configurable: true,
		enumerable: true,
		get: () => current_theme(),
	});

	return host;
}

/**
 * The one ancestor desk can vouch for: the workspace the reader was on
 * immediately before this page. Only the previous route counts — the rule
 * `frappe.breadcrumbs.set_workspace` already follows — because a workspace
 * further back is a parent the reader never came through. No workspace behind
 * us means no crumb: a cold link shows the page's own name and nothing else,
 * which beats inventing a parent.
 */
function entry_breadcrumbs() {
	const previous = frappe.route_history?.slice(-2)[0];
	if (!previous || previous[0] !== "Workspaces") return [];

	const is_private = previous[1] === "private";
	const name = is_private ? previous[2] : previous[1];
	if (!name) return [];

	const workspace = frappe.workspaces?.[frappe.router.slug(name)];
	return [
		{
			label: __(workspace?.title || name),
			// The path form, not the ["Workspaces", slug] standard route: it is
			// what carries a private workspace's prefix, and it is how the
			// sidebar routes to a workspace page.
			route: frappe.router.slug(is_private ? `private/${name}` : name),
		},
	];
}

/**
 * Soft re-mount on rebuild. Teardown is idempotent, so re-mounting in place is
 * safe; only islands whose asset hash actually moved are touched.
 */
function on_hot_update() {
	for (const [target, entry] of [...islands]) {
		if (!document.body.contains(target)) {
			unmount_island(target);
			continue;
		}

		try {
			if (resolve_island(entry.name).js === entry.url) continue;
		} catch (e) {
			console.error(e);
			continue;
		}

		mount_island(entry.name, target, entry.context).catch((e) =>
			console.error(`island: could not re-mount "${entry.name}"`, e)
		);
	}
}

frappe.provide("frappe.ui");
frappe.ui.mount_island = mount_island;
frappe.ui.unmount_island = unmount_island;

if (frappe.boot?.developer_mode) {
	frappe.hot_update = frappe.hot_update || [];
	frappe.hot_update.push(on_hot_update);
}
