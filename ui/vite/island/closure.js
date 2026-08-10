// The runtime closure: what an island links to instead of bundling.
//
// Read back from the `.runtime.js` keys the runtime build registered, so the
// runtime build, the import map and this preset cannot drift. Why it is read
// rather than derived, and why the reader checks it is current:
// ../../docs/adr/0008-island-externals-come-from-the-runtime-registration-not-a-second-walk.md

import fs from "node:fs";
import path from "node:path";
import { readAssetsJson } from "./bench.js";

const RUNTIME_KEY_SUFFIX = ".runtime.js";

/**
 * Every bare specifier the page's import map resolves.
 *
 * @param {string} assetsJsonPath
 * @returns {Set<string>}
 */
export function runtimeClosure(assetsJsonPath) {
	const specifiers = new Set(
		Object.keys(readAssetsJson(assetsJsonPath))
			.filter((key) => key.endsWith(RUNTIME_KEY_SUFFIX))
			.map((key) => key.slice(0, -RUNTIME_KEY_SUFFIX.length))
	);

	if (!specifiers.size)
		throw new Error(
			"island: the island runtime is not built, so there is nothing to link " +
				`against (no *${RUNTIME_KEY_SUFFIX} keys in ${assetsJsonPath}). ` +
				"Run `bench build --app frappe` first."
		);

	return specifiers;
}

/**
 * frappe-ui's browser-facing entry points, read off its `exports` map.
 *
 * The runtime build seeds its walk with these, and `assertClosureIsCurrent`
 * checks the registration against them, so what frappe-ui offers a page is
 * written down once. Its build-time exports (Tailwind preset, vite plugins,
 * vitepress theme) are node code and never reach a page; a wildcard names no
 * fixed entry.
 *
 * @param {string} frappeUiDir
 * @returns {string[]}
 */
export function frappeUiEntries(frappeUiDir) {
	const manifest = JSON.parse(fs.readFileSync(path.join(frappeUiDir, "package.json"), "utf-8"));
	const buildTimeOnly = /^\.\/(tailwind|vite|vitepress)/;
	const entries = [];

	for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
		if (subpath.includes("*") || buildTimeOnly.test(subpath)) continue;
		const file = typeof target === "string" ? target : target.import || target.default;
		if (!file || !/\.(js|ts)$/.test(file)) continue;
		entries.push(path.posix.join("frappe-ui", subpath.replace(/^\.\/?/, "")));
	}

	return entries;
}

/**
 * The package directory node resolution reaches, walking up from `fromDir`.
 * By hand rather than through `require.resolve`, because many packages do not
 * export `./package.json` and the answer wanted is the directory.
 */
export function resolvePackageDir(name, fromDir) {
	let dir = path.resolve(fromDir);
	for (;;) {
		const candidate = path.join(dir, "node_modules", name);
		if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Refuse a registration that is behind the frappe-ui on disk.
 *
 * assets.json proves the registration is consistent with itself, not that it is
 * current. One written before frappe-ui grew an entry names every specifier the
 * runtime knew about and none of the ones it did not — and the preset reads
 * that silence as "outside the closure", so it bundles the entry and everything
 * behind it. That is how a chart island came to carry its own echarts: the
 * runtime published `frappe-ui`, the island imported `frappe-ui/charts`, and
 * nothing but the size budget objected, at 4.5x over.
 *
 * The entry set is the one thing about the closure that is declared rather than
 * walked, so it is the one thing this side can check without redoing the walk
 * ADR 0008 rejects. Deeper drift — frappe-ui reaching for a new subpath of a
 * package it already uses — stays the warning's job.
 *
 * @param {Set<string>} closure
 * @param {string} root  the app's vite root, which resolves its own frappe-ui
 */
export function assertClosureIsCurrent(closure, root) {
	// An island that does not build on frappe-ui has nothing to compare.
	const frappeUiDir = resolvePackageDir("frappe-ui", root);
	if (!frappeUiDir) return;

	const missing = frappeUiEntries(frappeUiDir).filter((entry) => !closure.has(entry));
	if (!missing.length) return;

	throw new Error(
		`island: the island runtime does not publish ${missing.join(", ")}, ` +
			`which the frappe-ui at ${frappeUiDir} exports. Its registration is ` +
			"behind that tree, so an island importing one of these would bundle " +
			"its own copy of everything behind it rather than borrow the page's. " +
			"Rebuild the runtime with `bench build --app frappe`."
	);
}

/** `@tiptap/pm/state` → `{ name: "@tiptap/pm", subpath: "state" }`. */
export function parseSpecifier(specifier) {
	const parts = specifier.split("/");
	const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
	return { name, subpath: specifier.slice(name.length).replace(/^\//, "") };
}

export function isBareSpecifier(source) {
	return !/^(\.{1,2}\/|\/|\0|~|#|node:|data:|https?:)/.test(source);
}

/**
 * Keep every closure import a bare specifier, and bundle everything else.
 *
 * The match is on the whole specifier, not the package name: a subpath the
 * runtime never registered has no import-map entry, so externalising it would
 * turn a fat island into a broken one. Bundling it instead is merely fat, and
 * the size budget is what catches fat.
 *
 * @param {Set<string>} closure
 * @param {(message: string) => void} warn
 */
export function closureExternals(closure, warn) {
	const warned = new Set();

	return {
		name: "island-closure-externals",
		enforce: "pre",
		resolveId(source) {
			if (source.startsWith("node:")) return null;
			if (!isBareSpecifier(source)) return null;

			const clean = source.split("?")[0];
			// A stylesheet or an svg is an asset, not a module — it has no
			// import-map entry and belongs in this island's own output.
			if (/\.[a-z0-9]+$/i.test(clean) && !/\.[cm]?[jt]sx?$/i.test(clean)) return null;

			if (closure.has(clean)) return { id: clean, external: true };

			const { name } = parseSpecifier(clean);
			if (closure.has(name) && !warned.has(clean)) {
				warned.add(clean);
				warn(
					`${clean} is not an entry of the island runtime (${name} is), ` +
						"so it will be bundled into this island. Import the package " +
						"root instead, or accept the duplicate."
				);
			}
			return null;
		},
	};
}
