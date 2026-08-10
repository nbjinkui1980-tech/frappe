/**
 * Register the island runtime in assets.json, sharing the esbuild pipeline's
 * file and Redis invalidation (hence the reuse of esbuild/utils.js).
 *
 * The runtime owns every `.runtime.js` key plus the runtime CSS key, and
 * rewrites that whole set each build — a package that leaves the closure must
 * leave assets.json with it.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { APP, CSS_KEY, JS_KEY_SUFFIX } from "./runtime-config.mjs";

const require = createRequire(import.meta.url);
const {
  assets_path,
  get_redis_subscriber,
  log_warn,
} = require("../esbuild/utils.js");

const DIST_URL_PREFIX = path.posix.join("/", "assets", APP, "dist");

export const distDir = path.join(assets_path, APP, "dist");

/**
 * @param {Object<string, string>} relMap  asset key → path relative to the app's dist dir
 * @returns {Promise<Object<string, string>>}  asset key → public URL
 */
export async function writeRuntimeAssets(relMap) {
  const assetsJsonPath = path.resolve(assets_path, "assets.json");

  let existing = {};
  try {
    existing = JSON.parse(await fs.promises.readFile(assetsJsonPath, "utf-8"));
  } catch {
    // Missing or empty — the esbuild build will populate the rest.
  }

  const kept = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !ownsKey(key))
  );
  const written = Object.fromEntries(
    Object.entries(relMap).map(([key, rel]) => [
      key,
      path.posix.join(DIST_URL_PREFIX, rel.split(path.sep).join("/")),
    ])
  );

  await fs.promises.mkdir(path.dirname(assetsJsonPath), { recursive: true });
  await fs.promises.writeFile(
    assetsJsonPath,
    JSON.stringify({ ...kept, ...written }, null, 4)
  );
  await invalidateAssetsCache();
  return written;
}

export function ownsKey(key) {
  return key === CSS_KEY || key.endsWith(JS_KEY_SUFFIX);
}

export async function readAssetsJson() {
  return JSON.parse(
    await fs.promises.readFile(
      path.resolve(assets_path, "assets.json"),
      "utf-8"
    )
  );
}

async function invalidateAssetsCache() {
  if (process.env.FRAPPE_DOCKER_BUILD) return;
  let client;
  try {
    client = get_redis_subscriber("redis_cache");
    await client.connect();
    await client.del("assets_json");
  } catch {
    log_warn("island: cannot connect to redis_cache to invalidate assets_json");
  } finally {
    // Close it — vite exits naturally, unlike esbuild.js which calls process.exit().
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
