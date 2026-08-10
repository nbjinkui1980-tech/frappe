// The island build preset: it fixes everything the mount contract depends on
// and leaves the app only its entry list. Usage and options in ../../README.md.
//
// One vite build per entry. An island is loaded on its own, so there is nothing
// to share between entries, and a build apiece is what gives each its own
// stylesheet, its own directory to empty, and a size budget that means anything.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { build } from "vite";
import { islandVue } from "./vue.js";
import { lucideIconsPlugin } from "frappe-ui/vite/lucideIconsPlugin";
import {
	benchPaths,
	cssAssetKey,
	findBenchRoot,
	jsAssetKey,
	notifyRebuild,
	writeIslandAssets,
} from "./bench.js";
import { assertClosureIsCurrent, closureExternals, runtimeClosure } from "./closure.js";
import { writeIslandTailwindConfig } from "./tailwind.js";
import rootToHost from "./root-to-host.js";

const require = createRequire(import.meta.url);
const tailwindcss = require("tailwindcss");
const autoprefixer = require("autoprefixer");

/**
 * Bytes of JS plus CSS a single island may weigh, before compression.
 *
 * A backstop, not a target: an order of magnitude below the failure it catches,
 * which is an entry dragging in the SPA's router graph and unscoped stylesheet
 * (measured on the POC: 2.3 MB of JS, 4.8 MB of CSS). Apps pin `budget` to their
 * own first clean build plus slack.
 */
export const DEFAULT_BUDGET = 256 * 1024;

/** The CSS module every entry gets, holding the Tailwind directives. */
const TAILWIND_ENTRY = "virtual:island.css";

/**
 * Build every island of an app.
 *
 * @param {Object} options
 * @param {string} options.app       frappe app the output belongs to, e.g. `insights`
 * @param {string} options.root      the app's frontend directory (the vite root)
 * @param {Object<string,string>} options.entries  asset base name → entry file
 * @param {number} [options.budget]  bytes of JS + CSS per entry; over it fails the build
 * @param {string[]} [options.content]  Tailwind globs, relative to `root`
 * @param {string[]} [options.tailwindPlugins]  the app's Tailwind plugins, by module specifier
 * @param {string[]} [options.blocklist]  classes the runtime sheet already carries
 * @param {(string|RegExp)[]} [options.forbiddenImports]  escape hatch: fail on a matching import
 * @param {import('vite').PluginOption[]} [options.plugins]  extra plugins
 * @param {boolean} [options.production]
 * @param {boolean} [options.watch]
 */
export async function buildIslands(options) {
	const entries = Object.entries(options.entries ?? {});
	if (!entries.length) throw new Error("island: no entries to build");

	const context = islandContext(options);
	console.log(
		`[island] building ${entries.length} island(s) for ${options.app} ` +
			`[mode=${context.mode}${options.watch ? ", watch" : ""}]`
	);

	for (const [name, entryFile] of entries) {
		const result = await build(islandConfig(name, entryFile, context));
		if (options.watch && typeof result?.on === "function")
			result.on("event", (event) => {
				if (event.code === "ERROR")
					console.error(`[island] ${name}:`, event.error?.message);
			});
	}
}

/**
 * Everything the per-entry configs share: bench paths, the runtime closure, and
 * the resolved Tailwind config. Resolved once because each is a disk walk.
 */
export function islandContext(options) {
	if (!options.app) throw new Error("island: `app` is required");
	if (!options.root) throw new Error("island: `root` is required");

	// Real path, because vite reports module ids as real paths: a root reached
	// through a symlink would never match the entry it resolves to.
	const root = fs.realpathSync(path.resolve(options.root));
	const paths = benchPaths(findBenchRoot(root), options.app);
	const closure = runtimeClosure(paths.assetsJsonPath);
	assertClosureIsCurrent(closure, root);

	return {
		...options,
		root,
		paths,
		mode: options.production ? "production" : "development",
		budget: options.budget ?? DEFAULT_BUDGET,
		closure,
		tailwind: writeIslandTailwindConfig(root, options),
	};
}

/** The vite config for one island entry. */
export function islandConfig(name, entryFile, context) {
	if (!/^[\w.-]+$/.test(name))
		throw new Error(
			`island: entry name "${name}" must be a bare word — it becomes an ` +
				"assets.json key and a directory name."
		);

	const entryPath = fs.realpathSync(path.resolve(context.root, entryFile));
	const outDir = path.join(context.paths.distDir, name);

	return {
		root: context.root,
		base: `${path.posix.join(context.paths.urlPrefix, name)}/`,
		configFile: false,
		envFile: false,
		publicDir: false,
		mode: context.mode,
		logLevel: "warn",
		define: {
			__VUE_OPTIONS_API__: "true",
			__VUE_PROD_DEVTOOLS__: "false",
			__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
		},
		css: {
			postcss: {
				plugins: [tailwindcss(context.tailwind), autoprefixer, rootToHost],
			},
		},
		plugins: [
			// `pre` so it claims `~icons/lucide/<name>` before anything else.
			{ ...lucideIconsPlugin(), enforce: "pre" },
			tailwindEntry(entryPath),
			closureExternals(context.closure, (message) =>
				console.warn(`[island] ${name}: ${message}`)
			),
			...(context.forbiddenImports?.length
				? [forbiddenImports(context.forbiddenImports)]
				: []),
			islandVue(),
			emitIsland(name, context.budget, context.paths),
			...(context.plugins ?? []),
		],
		build: {
			outDir,
			// Its own directory, so emptying it cannot touch the legacy pipeline's
			// output, another island's, or the runtime's.
			emptyOutDir: true,
			minify: context.mode === "production" ? "esbuild" : false,
			sourcemap: false,
			// One extracted stylesheet per island — the mount helper adopts it into
			// the shadow root after the runtime's.
			cssCodeSplit: false,
			modulePreload: false,
			reportCompressedSize: false,
			target: "esnext",
			rollupOptions: {
				input: { [name]: entryPath },
				// An island is imported for its `mount` export, not run for its
				// side effects. Without this vite treats the entry as an app
				// entry, drops its exports, and tree-shakes the island away.
				preserveEntrySignatures: "exports-only",
				output: {
					format: "es",
					entryFileNames: `[name].island.[hash].js`,
					chunkFileNames: "chunks/[name].[hash].js",
					assetFileNames: (asset) =>
						(asset.names?.[0] ?? "").endsWith(".css")
							? `${name}.island.[hash][extname]`
							: "assets/[name].[hash][extname]",
				},
			},
			watch: context.watch ? {} : null,
		},
	};
}

/**
 * Give the entry its stylesheet. The preset owns what an island sheet contains,
 * so it injects the directives rather than the app writing them.
 *
 * No `@tailwind base`: that layer is 65 kB already in the runtime sheet, adopted
 * into the same shadow root just before this one.
 */
function tailwindEntry(entryPath) {
	return {
		name: "island-tailwind-entry",
		enforce: "pre",
		resolveId(source) {
			return source === TAILWIND_ENTRY ? TAILWIND_ENTRY : null;
		},
		load(id) {
			return id === TAILWIND_ENTRY ? "@tailwind components;\n@tailwind utilities;\n" : null;
		},
		transform(code, id) {
			if (id.split("?")[0] !== entryPath) return null;
			return { code: `import "${TAILWIND_ENTRY}";\n${code}`, map: null };
		},
	};
}

/** Optional, app-local: refuse an import the app has decided not to allow. */
function forbiddenImports(patterns) {
	const matches = (source) =>
		patterns.some((pattern) =>
			pattern instanceof RegExp ? pattern.test(source) : source === pattern
		);

	return {
		name: "island-forbidden-imports",
		enforce: "pre",
		resolveId(source, importer) {
			if (matches(source))
				this.error(
					`island: ${source} is a forbidden import` +
						(importer ? ` (from ${importer})` : "")
				);
			return null;
		},
	};
}

/**
 * Weigh the island, gate it on the budget, then register it in assets.json.
 *
 * One `writeBundle` hook for all three: it is the only hook a watcher replays,
 * and the earliest that sees the stylesheet at all (vite's css-post plugin emits
 * it after every user `generateBundle`). Splitting the gate out would not work —
 * rollup runs `writeBundle` hooks in parallel, so it has to sit in front of the
 * registration rather than beside it.
 */
function emitIsland(name, budget, paths) {
	return {
		name: "island-emit",
		async writeBundle(_options, bundle) {
			const nodes = Object.values(bundle);
			const entry = nodes.find((n) => n.type === "chunk" && n.isEntry);
			const css = nodes.find((n) => n.fileName.endsWith(".css"));

			const weights = { js: [], css: [] };
			for (const node of nodes) {
				const size = measure(node.type === "chunk" ? node.code : node.source);
				weights[node.fileName.endsWith(".css") ? "css" : "js"].push(size);
			}
			const js = sum(weights.js);
			const style = sum(weights.css);
			console.log(`[island] ${name}: ${report(js)} JS, ${report(style)} CSS`);

			if (js.raw + style.raw > budget)
				this.error(
					`island ${name} is ${kb(js.raw + style.raw)} of JS + CSS, over ` +
						`the ${kb(budget)} budget. An entry this size is linked to ` +
						"something it should not be — check what the entry graph " +
						"pulls in, or raise `budget` deliberately."
				);

			const relMap = {};
			if (entry) relMap[jsAssetKey(name)] = entry.fileName;
			if (css) relMap[cssAssetKey(name)] = css.fileName;

			notifyRebuild(name, await writeIslandAssets(paths, name, relMap));
		},
	};
}

/* --------------------------------------------------------------- measuring */

function measure(source) {
	const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
	return { raw: buffer.length, gzip: zlib.gzipSync(buffer, { level: 9 }).length };
}

const sum = (sizes) =>
	sizes.reduce((a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip }), {
		raw: 0,
		gzip: 0,
	});

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
const report = ({ raw, gzip }) => `${kb(raw)} raw / ${kb(gzip)} gzip`;
