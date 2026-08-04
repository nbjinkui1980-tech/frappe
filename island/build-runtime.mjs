/**
 * Build the island runtime: the shared closure every island imports.
 *
 * What comes out:
 *   • one hashed native-ESM file per entry specifier of every closure package,
 *     registered in assets.json as `<bare specifier>.runtime.js`
 *   • one hashed stylesheet, registered as `island_runtime.css`
 *
 * Nothing is inlined across package boundaries, so the page's import map is the
 * only linker and Vue exists exactly once per page. Imports within a package are
 * code-split into relative chunks.
 *
 * The closure is never written down: it is walked from the import graph out of
 * `vue`, `vue-router` and frappe-ui's browser entries, so yarn.lock stays the
 * only version authority.
 *
 * Usage: node island/build-runtime.mjs [--production]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import postcss from "postcss";
import {
  APP,
  CSS_KEY,
  FRAPPE_UI_DIR,
  REPO_ROOT,
  RUNTIME_DIST_SUBDIR,
  declaredRange,
  entryName,
  isBareSpecifier,
  isSingleton,
  jsAssetKey,
  lucideIconsPlugin,
  owningPackageDir,
  packageOutDir,
  parseSpecifier,
  readPackageJson,
  registerTypeScriptForSfcCompiler,
  resolvePackageDir,
  rootSpecifiers,
} from "./runtime-config.mjs";
import { distDir, writeRuntimeAssets } from "./assets.mjs";
import rootToHost from "./postcss-root-to-host.mjs";

const require = createRequire(import.meta.url);
const tailwindcss = require("tailwindcss");
const autoprefixer = require("autoprefixer");
const esbuild = require("esbuild");
const semver = require("semver");

const MODE = process.argv.includes("--production")
  ? "production"
  : "development";
const RUNTIME_DIR = path.join(distDir, RUNTIME_DIST_SUBDIR);
const RUNTIME_URL_BASE = path.posix.join(
  "/",
  "assets",
  APP,
  "dist",
  RUNTIME_DIST_SUBDIR
);
const TAILWIND_CONFIG = path.join(REPO_ROOT, "island/tailwind.config.mjs");

/** @typedef {{ name: string, dir: string, resolveFrom: string, version: string,
 *              entries: Set<string>, scanned: Set<string> }} ClosurePackage */

const packages = /** @type {Map<string, ClosurePackage>} */ (new Map());
const conflicts = new Set();
const nodeBuiltins = new Set();
const unresolved = new Set();
let lucide;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  registerTypeScriptForSfcCompiler();
  lucide = await lucideIconsPlugin();
  const started = Date.now();

  for (const specifier of rootSpecifiers()) linkSpecifier(specifier, REPO_ROOT);
  await discoverClosure();
  reportClosure();

  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  const { assetKeys, stylesheets } = await buildPackages();
  assetKeys[CSS_KEY] = await buildStylesheet(stylesheets);

  const written = await writeRuntimeAssets(assetKeys);
  report(written, Date.now() - started);
}

/* ---------------------------------------------------------------- discovery */

/**
 * Decide how one import crosses a package boundary, and record the target.
 *
 * The import map is flat: one bare specifier, one file. So when two copies of a
 * package are installed, one of them cannot have a specifier. The rule is a
 * single question — does the copy already in the closure satisfy the range the
 * importer declares?
 *
 *   yes → link to it (the usual case; that is what dedupe means)
 *   no  → bundle the second copy into the importer, where it needs no specifier
 *
 * Duplicating leaf utility code is what every consumer bundler already does.
 * Duplicating Vue is not, so for singletons the second copy is a build error.
 *
 * @returns {"link" | "inline"}
 */
function linkSpecifier(specifier, fromDir) {
  const { name, subpath } = parseSpecifier(specifier);
  const resolvedDir = resolvePackageDir(name, fromDir);
  if (!resolvedDir) {
    unresolved.add(specifier);
    return "link";
  }

  let pkg = packages.get(name);
  if (!pkg) {
    pkg = {
      name,
      dir: resolvedDir,
      resolveFrom: fromDir,
      version: readPackageJson(resolvedDir).version,
      entries: new Set(),
      scanned: new Set(),
    };
    packages.set(name, pkg);
  } else if (pkg.dir !== resolvedDir) {
    const owner = owningPackageDir(fromDir);
    const range = declaredRange(owner, name);
    // An undeclared dependency was found by hoisting luck — keep it shared.
    if (range && !semver.satisfies(pkg.version, range)) {
      const version = readPackageJson(resolvedDir).version;
      if (isSingleton(name)) {
        throw new Error(
          `island: ${path.basename(
            owner
          )} needs ${name}@${range} but the closure ` +
            `carries ${name}@${pkg.version}, and ${name} must exist exactly once. ` +
            `Align the versions in package.json.`
        );
      }
      conflicts.add(
        `${name}@${version} bundled into ${readPackageJson(owner).name}` +
          ` (needs ${range}, closure has ${pkg.version})`
      );
      return "inline";
    }
  }

  pkg.entries.add(subpath);
  return "link";
}

/** Walk the import graph to a fixed point. */
async function discoverClosure() {
  for (let pass = 1; ; pass++) {
    const pending = [...packages.values()]
      .map((pkg) => ({
        pkg,
        entries: [...pkg.entries].filter((e) => !pkg.scanned.has(e)),
      }))
      .filter(({ entries }) => entries.length);
    if (!pending.length) return;

    console.log(
      `[island] closure pass ${pass}: scanning ${pending.length} package(s)`
    );
    for (const { pkg, entries } of pending) {
      await build(packageConfig(pkg, entries, { discover: true }));
      entries.forEach((entry) => pkg.scanned.add(entry));
    }
  }
}

function reportClosure() {
  const entryCount = [...packages.values()].reduce(
    (n, p) => n + p.entries.size,
    0
  );
  console.log(
    `[island] closure: ${packages.size} packages, ${entryCount} entry specifiers [mode=${MODE}]`
  );
  for (const conflict of conflicts)
    console.log(`[island] second copy: ${conflict}`);
  if (nodeBuiltins.size)
    console.warn(
      `[island] WARNING node builtins left in the graph: ${[
        ...nodeBuiltins,
      ].join(", ")}`
    );
  if (unresolved.size)
    console.warn(
      `[island] WARNING unresolved specifiers: ${[...unresolved].join(", ")}`
    );
}

/* ------------------------------------------------------------------- builds */

async function buildPackages() {
  const assetKeys = {};
  const stylesheets = [];

  // frappe-ui first so its component styles lead the concatenated sheet.
  const ordered = [...packages.values()].sort((a, b) =>
    a.name === "frappe-ui"
      ? -1
      : b.name === "frappe-ui"
      ? 1
      : a.name.localeCompare(b.name)
  );

  for (const pkg of ordered) {
    const result = await build(packageConfig(pkg, [...pkg.entries]));
    const output = (Array.isArray(result) ? result[0] : result).output;

    for (const chunk of output) {
      if (chunk.type !== "chunk" || !chunk.isEntry) continue;
      const subpath = subpathForEntryName(pkg, chunk.name);
      const specifier = subpath ? `${pkg.name}/${subpath}` : pkg.name;
      assetKeys[jsAssetKey(specifier)] = path.posix.join(
        RUNTIME_DIST_SUBDIR,
        packageOutDir(pkg.name),
        chunk.fileName
      );
    }
    stylesheets.push(
      ...takeStylesheets(path.join(RUNTIME_DIR, packageOutDir(pkg.name)))
    );
  }

  return { assetKeys, stylesheets };
}

/**
 * Read and remove the stylesheets a package build extracted. Collected off disk
 * rather than out of the bundle because vite's own css-post plugin emits the
 * asset after every user plugin's `generateBundle` has run.
 */
function takeStylesheets(outDir) {
  const contents = [];
  for (const file of collectFiles(outDir).filter((f) => f.endsWith(".css"))) {
    contents.push(fs.readFileSync(file, "utf-8"));
    fs.rmSync(file);
  }
  return contents;
}

const subpathForEntryName = (pkg, name) =>
  [...pkg.entries].find((entry) => entryName(entry) === name) ?? "";

/**
 * One Vite build per package. Every import that leaves the package stays a bare
 * specifier; imports inside it are code-split into relative chunks.
 */
function packageConfig(pkg, entries, { discover = false } = {}) {
  const outDir = path.join(RUNTIME_DIR, packageOutDir(pkg.name));
  const isFrappeUi = pkg.name === "frappe-ui";

  return {
    // Resolving from the *importer's* directory is what makes node resolution
    // (and so yarn.lock) the version authority: frappe-ui's nested @vueuse/core
    // wins over the older copy desk's legacy bundles use. It is also always a
    // real path, which a vite root must be — vite reports module ids as real
    // paths, and frappe-ui is reached through a symlink.
    root: pkg.resolveFrom,
    base: `${path.posix.join(RUNTIME_URL_BASE, packageOutDir(pkg.name))}/`,
    configFile: false,
    publicDir: false,
    mode: MODE,
    logLevel: "warn",
    define: {
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    css: {
      postcss: {
        plugins: discover
          ? []
          : // Tailwind only where source uses `@apply` — that is frappe-ui's own
            // components. Everywhere else it would just rescan for nothing.
            [
              ...(isFrappeUi ? [tailwindcss(TAILWIND_CONFIG)] : []),
              autoprefixer,
              rootToHost,
            ],
      },
    },
    plugins: [...(isFrappeUi ? [lucide, vue()] : []), closureExternals(pkg)],
    build: {
      outDir,
      emptyOutDir: false,
      write: !discover,
      minify: discover ? false : MODE === "production" ? "esbuild" : false,
      sourcemap: false,
      cssCodeSplit: false,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: Object.fromEntries(
          entries.map((entry) => [
            entryName(entry),
            entry ? `${pkg.name}/${entry}` : pkg.name,
          ])
        ),
        // Runtime entries are modules other code imports; keep their exports.
        preserveEntrySignatures: "allow-extension",
        output: {
          format: "es",
          entryFileNames: "[name].[hash].js",
          chunkFileNames: "chunks/[name].[hash].js",
          assetFileNames: "assets/[name].[hash][extname]",
        },
      },
    },
  };
}

/** Keep every cross-package import a bare specifier. */
function closureExternals(pkg) {
  return {
    name: "island-closure-externals",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer) return null; // an entry of this package
      if (source.startsWith("node:")) {
        nodeBuiltins.add(source);
        return { id: source, external: true };
      }
      if (!isBareSpecifier(source)) return null;

      const clean = source.split("?")[0];
      // Only modules get an import-map entry. A stylesheet belongs in the one
      // sheet, and an asset (`lucide-static/sprite.svg`) belongs in the output
      // next to the package that asked for it.
      if (/\.[a-z0-9]+$/i.test(clean) && !/\.[cm]?[jt]sx?$/i.test(clean))
        return null;
      const { name } = parseSpecifier(clean);
      if (name === pkg.name) return null; // self-reference, bundle it

      const fromDir = path.dirname(importer.split("?")[0]);
      if (linkSpecifier(clean, fromDir) === "inline") return null;
      return { id: clean, external: true };
    },
  };
}

/* ---------------------------------------------------------------------- CSS */

/**
 * One stylesheet: preflight and `:host` tokens, then the closure's component
 * CSS, then the utilities frappe-ui's source uses. Tailwind's own cascade, so
 * a utility still beats a component rule.
 */
async function buildStylesheet(componentStyles) {
  const base = await runPostcss("@tailwind base;\n@tailwind components;\n");
  const utilities = await runPostcss("@tailwind utilities;\n");
  const merged = [base, ...componentStyles, utilities].join("\n");

  const { code } = await esbuild.transform(merged, {
    loader: "css",
    minify: MODE === "production",
  });
  const hash = crypto
    .createHash("sha256")
    .update(code)
    .digest("hex")
    .slice(0, 8);
  const fileName = `runtime.${hash}.css`;

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, fileName), code);
  return path.posix.join(RUNTIME_DIST_SUBDIR, fileName);
}

async function runPostcss(source) {
  const result = await postcss([
    tailwindcss(TAILWIND_CONFIG),
    autoprefixer,
    rootToHost,
  ]).process(source, { from: path.join(FRAPPE_UI_DIR, "src/style.css") });
  return result.css;
}

/* ------------------------------------------------------------------ reports */

function report(written, elapsedMs) {
  const files = collectFiles(RUNTIME_DIR);
  const js = files.filter((f) => f.endsWith(".js"));
  const cssFiles = files.filter((f) => f.endsWith(".css"));

  const perPackage = [...packages.values()]
    .map((pkg) => {
      const dir = path.join(RUNTIME_DIR, packageOutDir(pkg.name));
      const owned = collectFiles(dir).filter((f) => f.endsWith(".js"));
      return { name: pkg.name, version: pkg.version, ...measure(owned) };
    })
    .sort((a, b) => b.raw - a.raw);

  const total = measure(js);
  const css = measure(cssFiles);

  console.log(`\n[island] runtime built in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(
    `[island] JS   ${kb(total.raw)} raw / ${kb(total.gzip)} gzip across ${
      js.length
    } files`
  );
  console.log(`[island] CSS  ${kb(css.raw)} raw / ${kb(css.gzip)} gzip`);
  console.log("[island] largest packages:");
  for (const pkg of perPackage.slice(0, 12)) {
    console.log(
      `           ${pkg.name}@${pkg.version}`.padEnd(46) +
        `${kb(pkg.raw).padStart(10)} raw  ${kb(pkg.gzip).padStart(10)} gzip`
    );
  }
  console.log(
    `[island] ${Object.keys(written).length} assets.json keys written`
  );
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

function measure(files) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    raw += buffer.length;
    gzip += zlib.gzipSync(buffer, { level: 9 }).length;
  }
  return { raw, gzip };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
