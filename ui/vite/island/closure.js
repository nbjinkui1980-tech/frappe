// The runtime closure: what an island links to instead of bundling.
//
// Read back from the `.runtime.js` keys the runtime build registered, so the
// runtime build, the import map and this preset cannot drift. Why it is read
// rather than derived: ../../docs/adr/0008-island-externals-come-from-the-runtime-registration-not-a-second-walk.md

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
