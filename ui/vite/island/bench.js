// Bench paths and assets.json registration for the island build. Registration
// mirrors island/assets.mjs in the framework repo: merge in, rewrite only the
// keys this build owns, drop the Redis copy so python re-reads the file.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Suffixes that make an island key unmistakable to the module loader. */
export const JS_KEY_SUFFIX = ".island.js";
export const CSS_KEY_SUFFIX = ".island.css";

/** Where an app's islands live under its dist directory. */
export const ISLAND_DIST_SUBDIR = "island";

export const jsAssetKey = (name) => `${name}${JS_KEY_SUFFIX}`;
export const cssAssetKey = (name) => `${name}${CSS_KEY_SUFFIX}`;

/**
 * The bench root: the directory holding `sites/` and `apps/`. Discovered rather
 * than configured, since the preset only ever runs inside one. `FRAPPE_BENCH_ROOT`
 * short-circuits it, the escape hatch frappe's own esbuild/utils.js honours.
 *
 * @param {string} from  Directory to start walking up from (the vite root).
 */
export function findBenchRoot(from) {
	if (process.env.FRAPPE_BENCH_ROOT) return path.resolve(process.env.FRAPPE_BENCH_ROOT);

	let dir = path.resolve(from);
	for (;;) {
		if (fs.existsSync(path.join(dir, "sites")) && fs.existsSync(path.join(dir, "apps")))
			return dir;
		const parent = path.dirname(dir);
		if (parent === dir)
			throw new Error(
				`island: no bench root above ${from} (looked for a directory with ` +
					"sites/ and apps/). Set FRAPPE_BENCH_ROOT to point at one."
			);
		dir = parent;
	}
}

/** Every path the build writes to or reads from, derived from one bench root. */
export function benchPaths(benchRoot, app) {
	const sitesPath = path.join(benchRoot, "sites");
	const assetsPath = path.join(sitesPath, "assets");
	return {
		benchRoot,
		sitesPath,
		assetsPath,
		assetsJsonPath: path.join(assetsPath, "assets.json"),
		distDir: path.join(assetsPath, app, "dist", ISLAND_DIST_SUBDIR),
		urlPrefix: path.posix.join("/", "assets", app, "dist", ISLAND_DIST_SUBDIR),
	};
}

export function readAssetsJson(assetsJsonPath) {
	try {
		return JSON.parse(fs.readFileSync(assetsJsonPath, "utf-8"));
	} catch {
		// Missing or empty — the esbuild pipeline populates the rest.
		return {};
	}
}

/**
 * Register one island's built files in assets.json.
 *
 * An island owns every key pointing into its own output directory, and that
 * whole set is rewritten on each build — so an entry that stops emitting CSS
 * loses its CSS key instead of leaving a dangling one behind. Keys belonging to
 * other entries and other apps are untouched.
 *
 * @param {Object} paths        from `benchPaths`
 * @param {string} name         entry name, e.g. `insights_dashboard`
 * @param {Object<string,string>} relMap  asset key → path relative to the
 *                                        entry's output directory
 * @returns {Promise<Object<string,string>>}  asset key → public URL
 */
export async function writeIslandAssets(paths, name, relMap) {
	const ownPrefix = `${path.posix.join(paths.urlPrefix, name)}/`;
	const existing = readAssetsJson(paths.assetsJsonPath);

	const kept = Object.fromEntries(
		Object.entries(existing).filter(([, url]) => !url.startsWith(ownPrefix))
	);
	const written = Object.fromEntries(
		Object.entries(relMap).map(([key, rel]) => [
			key,
			path.posix.join(ownPrefix, rel.split(path.sep).join("/")),
		])
	);

	await fs.promises.mkdir(path.dirname(paths.assetsJsonPath), {
		recursive: true,
	});
	await fs.promises.writeFile(
		paths.assetsJsonPath,
		JSON.stringify({ ...kept, ...written }, null, 4)
	);
	await invalidateAssetsCache(paths);
	return written;
}

/**
 * Drop the Redis copy of assets.json so the next page render sees the new
 * hashes. The connection details live in the site config, so this borrows
 * frappe's own helper rather than re-deriving them; a tree without frappe (a
 * test fixture) simply skips it.
 */
async function invalidateAssetsCache(paths) {
	if (process.env.FRAPPE_DOCKER_BUILD) return;
	const utils = loadFrappeBuildUtils(paths.benchRoot);
	if (!utils) return;

	let client;
	try {
		client = utils.get_redis_subscriber("redis_cache");
		await client.connect();
		await client.del("assets_json");
	} catch {
		console.warn("[island] cannot reach redis_cache to invalidate assets_json");
	} finally {
		// Close it — vite exits naturally, unlike esbuild.js which calls
		// process.exit().
		try {
			await client?.quit();
		} catch {
			try {
				await client?.disconnect();
			} catch {
				// never connected
			}
		}
	}
}

function loadFrappeBuildUtils(benchRoot) {
	const utilsPath = path.join(benchRoot, "apps/frappe/esbuild/utils.js");
	if (!fs.existsSync(utilsPath)) return null;
	try {
		return createRequire(import.meta.url)(utilsPath);
	} catch {
		return null;
	}
}

/**
 * Announce a finished (re)build.
 *
 * TODO(hot_update): watch mode should publish frappe's `build_event` on the
 * `events` Redis channel — `{ success: true, changed_files, live_reload }` —
 * so desk busts its asset cache and soft re-mounts the island. That is a
 * framework-side integration step (it needs the same publisher the esbuild
 * watcher uses); until it lands, a rebuild is visible only on reload. The
 * changed URLs are already in hand here, which is all the publisher needs.
 */
export function notifyRebuild(name, urls) {
	console.log(`[island] ${name}: ${Object.values(urls).join(", ")}`);
}
