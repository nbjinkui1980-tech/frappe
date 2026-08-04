/**
 * Entry point for `yarn build` / `yarn production`, and so for `bench build`:
 * esbuild with the arguments verbatim, then the island runtime when frappe is
 * in the build.
 *
 * A dispatcher rather than a `&&` chain in package.json, because yarn appends a
 * script's trailing arguments to the *last* command in the chain — which is how
 * the POC's `--apps` silently rebuilt every app.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { FRAPPE_UI_DIR, REPO_ROOT } from "./runtime-config.mjs";

const args = process.argv.slice(2);

await run(["esbuild", ...args]);
if (buildsFrappe(args) && hasFrappeUi()) {
  await run([
    "island/build-runtime.mjs",
    ...args.filter((arg) => arg === "--production"),
  ]);
}

function buildsFrappe(argv) {
  const index = argv.indexOf("--apps");
  if (index === -1 || !argv[index + 1]) return true;
  return argv[index + 1].split(",").includes("frappe");
}

/**
 * frappe-ui is a `link:` checkout until the island prerequisites land upstream,
 * and it is gitignored. A tree without it still builds the legacy bundles.
 */
function hasFrappeUi() {
  if (fs.existsSync(path.join(FRAPPE_UI_DIR, "package.json"))) return true;
  console.warn(
    "[island] skipping the runtime build — no frappe-ui checkout at ./frappe-ui"
  );
  return false;
}

function run(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) => (code ? process.exit(code) : resolve()));
  });
}
