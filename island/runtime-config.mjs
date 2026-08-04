/**
 * Shared plumbing for the island runtime build — the second asset pipeline,
 * beside the legacy esbuild one, which it leaves untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const FRAPPE_UI_DIR = path.join(REPO_ROOT, "frappe-ui");
export const APP = "frappe";

/** Output directory for the runtime, relative to `sites/assets/<app>/dist`. */
export const RUNTIME_DIST_SUBDIR = path.posix.join("island", "runtime");

/**
 * assets.json key forms. Both are distinct from the legacy `.bundle.js` keys
 * and from the `.island.js` keys the spec pins for island entries, so the
 * module loader and the classic loader never claim the same asset.
 *
 * A runtime JS key is `<bare specifier>.runtime.js`, so the import map is a
 * pure string transform over assets.json: drop the suffix, keep the rest.
 */
export const JS_KEY_SUFFIX = ".runtime.js";
export const CSS_KEY = "island_runtime.css";

export const jsAssetKey = (specifier) => `${specifier}${JS_KEY_SUFFIX}`;

/** Inverse of `jsAssetKey` — what the import-map emitter will use. */
export const specifierFromAssetKey = (key) =>
  key.endsWith(JS_KEY_SUFFIX) ? key.slice(0, -JS_KEY_SUFFIX.length) : null;

/**
 * The closure seed. The spec defines it as "Vue, vue-router, frappe-ui, and
 * everything frappe-ui drags in" — so these three are the only names written
 * down anywhere. Everything else is discovered from the import graph, with the
 * installed tree (and therefore yarn.lock) as the version authority.
 */
export function rootSpecifiers() {
  return ["vue", "vue-router", ...frappeUiEntrySpecifiers()];
}

/**
 * frappe-ui's browser-facing entry points, read off its `exports` map. Its
 * build-time exports (tailwind preset, vite plugins, vitepress theme) are node
 * code and never reach a page; `./drive/*` is a wildcard with no fixed entry.
 */
function frappeUiEntrySpecifiers() {
  const { exports: exportsMap } = readPackageJson(FRAPPE_UI_DIR);
  const buildTimeOnly = /^\.\/(tailwind|vite|vitepress)/;
  const specifiers = [];

  for (const [subpath, target] of Object.entries(exportsMap || {})) {
    if (subpath.includes("*") || buildTimeOnly.test(subpath)) continue;
    const file =
      typeof target === "string" ? target : target.import || target.default;
    if (!file || !/\.(js|ts)$/.test(file)) continue;
    specifiers.push(
      path.posix.join("frappe-ui", subpath.replace(/^\.\/?/, ""))
    );
  }

  return specifiers;
}

export function readPackageJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
}

/** Split `@tiptap/pm/state` into `{ name: "@tiptap/pm", subpath: "state" }`. */
export function parseSpecifier(specifier) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  return { name, subpath: specifier.slice(name.length).replace(/^\//, "") };
}

export function isBareSpecifier(source) {
  return (
    !/^(\.{1,2}\/|\/|\0|~|#|node:|data:|https?:)/.test(source) &&
    !path.isAbsolute(source)
  );
}

/**
 * Node resolution for the *package directory*, walking up from `fromDir`.
 * Done by hand rather than through `require.resolve` because many packages do
 * not export `./package.json`, and because the answer must be the directory
 * (the version authority) and not an entry file.
 */
export function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json")))
      return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package directory a file belongs to. */
export function owningPackageDir(fromDir) {
  let dir = fromDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The semver range a package declares for one of its dependencies. */
export function declaredRange(ownerDir, name) {
  if (!ownerDir) return null;
  let manifest;
  try {
    manifest = readPackageJson(ownerDir);
  } catch {
    return null;
  }
  return (
    manifest.dependencies?.[name] ??
    manifest.peerDependencies?.[name] ??
    manifest.optionalDependencies?.[name] ??
    null
  );
}

/**
 * Packages that must exist exactly once on a page whatever the lockfile says.
 * Vue holds per-app state, its runtime packages are that state, and vue-router
 * and frappe-ui hang off it. Two copies is not a size problem, it is a
 * correctness one — so the build fails rather than ship the bug.
 */
export function isSingleton(name) {
  return (
    name === "vue" ||
    name === "vue-router" ||
    name === "frappe-ui" ||
    name.startsWith("@vue/")
  );
}

/** A filesystem-safe output directory for a package, e.g. `@vueuse/core`. */
export const packageOutDir = (name) => name;

/** Rollup input name for an entry specifier; `frappe-ui/code-editor` → `code-editor`. */
export const entryName = (subpath) =>
  subpath ? subpath.replace(/\//g, "__") : "index";

/**
 * Resolves the `~icons/lucide/<name>` modules frappe-ui's source imports 83
 * times. The subpath export is the resolver without the auto-import plugins,
 * which is all the runtime needs — every icon here is imported by name.
 *
 * Lazily, because `build.mjs` also loads this module in trees that have no
 * frappe-ui checkout.
 */
export async function lucideIconsPlugin() {
  const { lucideIconsPlugin: plugin } = await import(
    "frappe-ui/vite/lucideIconsPlugin"
  );
  return { ...plugin(), enforce: "pre" };
}

/**
 * Vue SFC compilation of frappe-ui *source* needs TypeScript handed to
 * compiler-sfc: several components use the type-macro form of `defineProps`
 * with a type imported from another package, which compiler-sfc can only
 * resolve through the TS compiler API. @vitejs/plugin-vue does not register it.
 * Must be TS >= 5 — the types sit behind `exports` maps only `moduleResolution:
 * bundler` can follow.
 */
export function registerTypeScriptForSfcCompiler() {
  const { registerTS } = require("vue/compiler-sfc");
  registerTS(() => require("typescript"));
}
