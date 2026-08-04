/**
 * Check the built island runtime against the contract the loader depends on.
 *
 * The load-bearing claim is that a flat import map is a sufficient linker: any
 * bare specifier an emitted file imports must be a key of that map, and no
 * package may carry a private copy of another. Everything here tests the built
 * artifacts, not the build script.
 *
 * Usage: node island/verify-runtime.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  CSS_KEY,
  RUNTIME_DIST_SUBDIR,
  isBareSpecifier,
  parseSpecifier,
  specifierFromAssetKey,
} from "./runtime-config.mjs";
import { distDir, readAssetsJson } from "./assets.mjs";

const require = createRequire(import.meta.url);
const { init, parse } = require("es-module-lexer");
const { sites_path } = require("../esbuild/utils.js");

/** Strings from Vue's runtime that survive a production build. */
const VUE_MARKERS = ["ASYNC_COMPONENT_LOADER", "app unmount cleanup function"];
const VUE_OWNERS = ["@vue/runtime-core", "@vue/runtime-dom"];

const RUNTIME_DIR = path.join(distDir, RUNTIME_DIST_SUBDIR);
const failures = [];
const check = (ok, message) => void (ok || failures.push(message));

async function main() {
  await init;

  const assets = await readAssetsJson();
  const jsKeys = Object.keys(assets).filter((key) =>
    key.endsWith(".runtime.js")
  );
  check(
    jsKeys.length > 0,
    "assets.json holds no .runtime.js keys — has the runtime been built?"
  );
  check(Boolean(assets[CSS_KEY]), `assets.json holds no ${CSS_KEY} key`);

  const specifiers = new Set(jsKeys.map(specifierFromAssetKey));
  const registered = new Map(
    jsKeys.map((key) => [specifierFromAssetKey(key), localPath(assets[key])])
  );

  verifyRegistration(registered);
  const emitted = verifyModules(registered, specifiers);
  verifyNoInlining(emitted);
  verifyStylesheet(localPath(assets[CSS_KEY]));
  verifyImportMapLoads();
  report(registered, emitted, localPath(assets[CSS_KEY]));
}

function localPath(url) {
  return path.join(sites_path, url.replace(/^\//, ""));
}

/** One hashed file per specifier, inside its own package's directory. */
function verifyRegistration(registered) {
  const seen = new Map();
  const packages = new Set();

  for (const [specifier, file] of registered) {
    const { name } = parseSpecifier(specifier);
    packages.add(name);
    check(
      fs.existsSync(file),
      `${specifier}: registered file is missing (${file})`
    );
    check(
      /\.[A-Za-z0-9_-]{8}\.js$/.test(file),
      `${specifier}: registered file carries no content hash`
    );
    check(
      path.dirname(file).endsWith(path.join("runtime", name)),
      `${specifier}: file lives outside its package directory (${file})`
    );

    const owner = seen.get(file);
    check(!owner, `${file}: registered for both ${owner} and ${specifier}`);
    seen.set(file, specifier);
  }

  for (const name of packages) {
    const files = [...registered].filter(
      ([s]) => parseSpecifier(s).name === name
    );
    check(files.length >= 1, `${name}: no registered file`);
  }
}

/** Every emitted file parses as ESM, and every bare import it makes is mappable. */
function verifyModules(registered, specifiers) {
  const emitted = allJsFiles(RUNTIME_DIR);
  check(
    emitted.length >= registered.size,
    "fewer emitted files than registered specifiers"
  );

  for (const file of emitted) {
    const source = fs.readFileSync(file, "utf-8");
    let imports;
    try {
      [imports] = parse(source, file);
    } catch (error) {
      check(false, `${short(file)}: does not parse as ESM (${error.message})`);
      continue;
    }

    for (const record of imports) {
      const specifier = record.n;
      if (!specifier || !isBareSpecifier(specifier)) continue;
      check(
        specifiers.has(specifier),
        `${short(
          file
        )}: imports "${specifier}", which the import map cannot resolve`
      );
    }
  }

  return emitted;
}

/** Spot-check that Vue's runtime is not copied into any other package. */
function verifyNoInlining(emitted) {
  for (const marker of VUE_MARKERS) {
    const holders = emitted.filter((file) =>
      fs.readFileSync(file, "utf-8").includes(marker)
    );
    check(
      holders.length > 0,
      `vue marker "${marker}" is in no emitted file — pick a new marker`
    );
    for (const file of holders) {
      check(
        VUE_OWNERS.some((owner) => short(file).startsWith(`${owner}/`)),
        `${short(file)}: carries an inlined copy of Vue's runtime ("${marker}")`
      );
    }
  }
}

/**
 * Load the runtime the way a page will: bare specifiers only, resolved through
 * nothing but the map. Vue is the one that has to work — everything else in the
 * closure links against it.
 */
function verifyImportMapLoads() {
  const hooks = pathToFileURL(
    path.join(import.meta.dirname, "import-map-hooks.mjs")
  ).href;
  const bootstrap = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(
    hooks
  )})`;
  const probe = `
		const vue = await import("vue");
		const router = await import("vue-router");
		if (typeof vue.createApp !== "function") throw new Error("vue exports no createApp");
		if (typeof router.createRouter !== "function") throw new Error("vue-router exports no createRouter");
		const app = vue.createApp({ render: () => null });
		if (!app.mount) throw new Error("createApp returned no app");
	`;

  const result = spawnSync(
    process.execPath,
    ["--import", bootstrap, "--input-type=module", "-e", probe],
    { encoding: "utf-8" }
  );
  check(
    result.status === 0,
    `runtime does not load through the import map: ${(result.stderr || "")
      .trim()
      .split("\n")
      .pop()}`
  );
}

function verifyStylesheet(file) {
  check(fs.existsSync(file), `runtime stylesheet is missing (${file})`);
  if (!fs.existsSync(file)) return;

  const css = fs.readFileSync(file, "utf-8");
  check(
    /:host\s*{[^}]*--/.test(css),
    "runtime stylesheet holds no :host design tokens"
  );
  check(
    !css.includes(":root"),
    "runtime stylesheet still holds :root selectors"
  );
  // Nothing in a shadow tree can match these, so a leftover is a dead rule.
  check(
    !/[};]\s*(html|body)\s*[{,]/.test(css),
    "runtime stylesheet still targets html/body"
  );
  // Desk registers Inter as `InterVariable` and `Inter`. frappe-ui's own name
  // for the same typeface matches no registered face, so a survivor means the
  // island renders in the system font.
  check(
    !/InterVar(?![\w-])/.test(css),
    "runtime stylesheet still asks for InterVar, a family desk does not register"
  );
  check(
    /font-family:[^;}]*InterVariable/.test(css),
    "runtime stylesheet names none of desk's font families"
  );
}

/**
 * What a page actually pays: the statically-reachable graph of one entry. The
 * runtime as a whole is 400-odd files, and an island only ever loads its own
 * subgraph.
 */
function measureEntryGraph(entry, registered) {
  const seen = new Set();
  const queue = [registered.get(entry)].filter(Boolean);

  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const [imports] = parse(fs.readFileSync(file, "utf-8"), file);
    for (const record of imports) {
      if (record.d >= 0) continue; // loaded on demand, not at mount
      const specifier = record.n;
      if (!specifier) continue;
      queue.push(
        isBareSpecifier(specifier)
          ? registered.get(specifier)
          : path.resolve(path.dirname(file), specifier)
      );
    }
  }

  return { files: seen.size, ...measure([...seen]) };
}

/* ------------------------------------------------------------------ reports */

function report(registered, emitted, cssFile) {
  const js = measure(emitted);
  const css = measure([cssFile]);
  const packages = new Set(
    [...registered.keys()].map((s) => parseSpecifier(s).name)
  );

  console.log(
    `[island] ${packages.size} packages, ${registered.size} specifiers, ${emitted.length} files`
  );
  console.log(
    `[island] JS   ${kb(js.raw)} raw / ${kb(
      js.gzip
    )} gzip (whole closure on disk)`
  );
  console.log(`[island] CSS  ${kb(css.raw)} raw / ${kb(css.gzip)} gzip`);
  console.log("[island] static graph per entry:");
  for (const entry of ["vue", "vue-router", "frappe-ui", "echarts"]) {
    const graph = measureEntryGraph(entry, registered);
    console.log(
      `           ${entry}`.padEnd(24) +
        `${String(graph.files).padStart(4)} files  ` +
        `${kb(graph.raw).padStart(10)} raw  ${kb(graph.gzip).padStart(10)} gzip`
    );
  }

  if (failures.length) {
    console.error(`\n[island] ${failures.length} check(s) failed:`);
    for (const failure of failures.slice(0, 40))
      console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log("[island] all checks passed");
}

function allJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

const short = (file) => path.relative(RUNTIME_DIR, file);

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

await main();
