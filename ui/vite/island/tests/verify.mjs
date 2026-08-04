/**
 * Verify the island preset against a fixture app.
 *
 * The preset's seam is the build, so this is a build: it stages
 * `tests/fixture/` as a frontend inside a throwaway bench, runs the preset over
 * it, and reads the output back. What it checks is the contract the loader and
 * the mount helper depend on — bare closure imports, a stylesheet holding only
 * the app's own utilities with nothing document-scoped left in it, assets.json
 * keys in the `.island.js` / `.island.css` form, and a budget that actually
 * fails a build.
 *
 * A plain node script, like island/verify-runtime.mjs next door, because what
 * is under test is a build pipeline and not a unit.
 *
 * Prerequisite: the island runtime must be built — the preset reads the closure
 * out of assets.json. Run `bench build --app frappe` first.
 *
 * Usage:
 *   node ui/vite/island/tests/verify.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildIslands } from "../index.js";
import { findBenchRoot } from "../bench.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixture");
// ui/vite/island/tests → apps/frappe. The fixture borrows this tree's
// node_modules rather than installing its own.
const FRAMEWORK_ROOT = path.resolve(HERE, "../../../..");
const ENTRY = "island_fixture_panel";

const failures = [];

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

const check = (ok, what, detail = "") => {
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`
  );
  if (!ok) failures.push(what);
};

const bench = stageBench();
try {
  await run();
} finally {
  fs.rmSync(bench.root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n[island] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\n[island] preset verified");

async function run() {
  await buildIslands({
    app: "fixtureapp",
    root: bench.frontend,
    entries: { [ENTRY]: "src/islands/panel.js" },
    production: true,
  });

  const assets = JSON.parse(fs.readFileSync(bench.assetsJson, "utf-8"));
  const js = read(assets, `${ENTRY}.island.js`);
  const css = read(assets, `${ENTRY}.island.css`);

  console.log("\nassets.json registration");
  check(!!js, "an .island.js key is registered", assets[`${ENTRY}.island.js`]);
  check(
    !!css,
    "an .island.css key is registered",
    assets[`${ENTRY}.island.css`]
  );
  check(
    !Object.keys(assets).some((key) => key.endsWith(".bundle.js")),
    "no legacy .bundle.js key is claimed"
  );
  check(
    Object.keys(assets).filter((key) => key.endsWith(".runtime.js")).length > 0,
    "the runtime's keys survive the merge"
  );

  console.log("\nJS output");
  const imports = bareImports(js.text);
  check(/^\s*(import|export)\b/m.test(js.text), "output is ESM");
  check(imports.includes("vue"), "vue stays a bare import");
  check(imports.includes("frappe-ui"), "frappe-ui stays a bare import");
  // A bundled vue alone is six figures of bytes, so the weight is the tell.
  check(js.raw < 20 * 1024, "no inlined copy of the closure", kb(js.raw));
  check(/export\s*\{[^}]*\bmount\b/.test(js.text), "the mount export survives");
  check(js.text.includes("<path d="), "the lucide icon is inlined, not linked");

  console.log("\nCSS output");
  check(!/(^|[,}])\s*:root\b/.test(css.text), "no :root selector");
  check(!/(^|[,}])\s*html\b/.test(css.text), "no html selector");
  check(!/(^|[,}])\s*body\b/.test(css.text), "no body selector");
  check(css.text.includes(":host"), "document-level rules became :host");
  check(css.text.includes(".panel-accent"), "app CSS is kept");
  check(
    css.text.includes(".bg-surface-gray-2"),
    "the app's utilities are there"
  );
  check(
    !css.text.includes(".prose") && !css.text.includes("--ink-gray-1:"),
    "no frappe-ui utility or token dump",
    `${kb(css.raw)} total`
  );

  console.log("\nmeasured");
  console.log(`  JS   ${kb(js.raw)} raw / ${kb(js.gzip)} gzip`);
  console.log(`  CSS  ${kb(css.raw)} raw / ${kb(css.gzip)} gzip`);

  console.log("\nsize budget");
  const budget = js.raw + css.raw - 1;
  let failed = false;
  try {
    await buildIslands({
      app: "fixtureapp",
      root: bench.frontend,
      entries: { [ENTRY]: "src/islands/panel.js" },
      production: true,
      budget,
    });
  } catch (error) {
    failed = /over the/.test(error.message);
  }
  check(failed, `a ${kb(budget)} budget fails the build`);
}

/* ------------------------------------------------------------------ staging */

/**
 * A throwaway bench holding the fixture as an app frontend, so the preset
 * discovers its paths the way it will in a real one. assets.json is seeded with
 * the real bench's runtime keys — that set is what the closure is.
 */
function stageBench() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "island-verify-"));
  const frontend = path.join(root, "apps/fixtureapp/frontend");
  const assetsJson = path.join(root, "sites/assets/assets.json");

  fs.mkdirSync(path.dirname(assetsJson), { recursive: true });
  fs.cpSync(FIXTURE, frontend, { recursive: true });
  // Borrowed, not installed: vue, frappe-ui and the build tooling all live in
  // the tree the preset itself ships from.
  fs.symlinkSync(
    path.join(FRAMEWORK_ROOT, "node_modules"),
    path.join(frontend, "node_modules")
  );

  const built = JSON.parse(
    fs.readFileSync(
      path.join(findBenchRoot(FRAMEWORK_ROOT), "sites/assets/assets.json"),
      "utf-8"
    )
  );
  // Read the real bench's runtime keys first, then pin the preset to the
  // throwaway one — nothing this script runs may touch the real sites/assets.
  process.env.FRAPPE_BENCH_ROOT = root;
  fs.writeFileSync(
    assetsJson,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(built).filter(([key]) => key.endsWith(".runtime.js"))
      ),
      null,
      4
    )
  );

  return { root, frontend, assetsJson };
}

/* ------------------------------------------------------------------ reading */

function read(assets, key) {
  const url = assets[key];
  if (!url) return null;
  const file = path.join(bench.root, "sites", url.replace(/^\//, ""));
  const buffer = fs.readFileSync(file);
  return {
    text: buffer.toString("utf-8"),
    raw: buffer.length,
    gzip: zlib.gzipSync(buffer, { level: 9 }).length,
  };
}

/** Every bare specifier the module imports, in source order. */
function bareImports(source) {
  return [
    ...source.matchAll(
      /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g
    ),
  ]
    .map((match) => match[1] ?? match[2])
    .filter((specifier) => !/^[./]/.test(specifier));
}
