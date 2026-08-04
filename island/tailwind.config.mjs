/**
 * Tailwind config for the island runtime stylesheet.
 *
 * Scope is frappe-ui's own source and nothing else: the runtime sheet carries
 * the utilities frappe-ui components need. An app's island brings its own sheet
 * for its own templates, scanned by the island Vite preset.
 *
 * No `important` scoping and no disabled preflight — islands mount in a shadow
 * root, which isolates styles both ways. The one desk adaptation lives in the
 * PostCSS chain, not here: `postcss-root-to-host` turns the preset's `:root`
 * token block into `:host`.
 */
import frappeUIPreset from "frappe-ui/tailwind";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Absolute, because `bench build` runs from the bench root, not from apps/frappe.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** @type {import('tailwindcss').Config} */
export default {
  presets: [frappeUIPreset],
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [path.join(REPO_ROOT, "frappe-ui/src/**/*.{vue,js,ts,tsx}")],
  theme: { extend: {} },
};
