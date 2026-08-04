/**
 * Node resolution hooks standing in for the page's import map, so a plain node
 * process loads the built runtime the way a browser will. That is what makes
 * verify-runtime.mjs's smoke test worth anything.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CSS_KEY, specifierFromAssetKey } from "./runtime-config.mjs";
import { readAssetsJson } from "./assets.mjs";

const require = createRequire(import.meta.url);
const { sites_path } = require("../esbuild/utils.js");

const assets = await readAssetsJson();
const importMap = new Map(
  Object.entries(assets)
    .filter(([key]) => key !== CSS_KEY && key.endsWith(".runtime.js"))
    .map(([key, url]) => [
      specifierFromAssetKey(key),
      pathToFileURL(path.join(sites_path, url.replace(/^\//, ""))).href,
    ])
);

export async function resolve(specifier, context, next) {
  const url = importMap.get(specifier);
  if (url) return { url, shortCircuit: true, format: "module" };
  return next(specifier, context);
}
