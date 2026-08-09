# @framework/ui

Shared Vue components and utilities for Frappe apps that depend on the backend. This is an extension of frappe-ui for framework specific components that all apps need. Lives at `frappe/ui` in framework and is consumed by other apps (studio, builder, hrms, …) as a local package - **never published to npm**.

Code is shipped as raw `.vue`/`.ts` source (no build step) and compiled by the consuming app's bundler, exactly like `frappe-ui`. `vue`, `vue-router` and `frappe-ui` are **peer dependencies** so the host app's single copy of each is reused — this avoids
duplicate Vue instances and mismatched router contexts.

## Consuming this package from another Frappe app

Frappe apps are independent git repos sitting side by side under the bench `apps/`
folder, so the package is linked by **relative path** using yarn's `link:` protocol
(a symlink — not `file:`, not a registry install). Three small changes in the
consuming frontend:

### 1. Declare the dependency — `package.json`

```jsonc
{
  "dependencies": {
    "@framework/ui": "link:../../frappe/ui"
  }
}
```

The path is relative to the file's own directory. From `studio/frontend` that is
`../../frappe/ui`; adjust the `../` depth for your app. Then:

```bash
yarn install   # creates node_modules/framework/ui -> ../../frappe/ui
```

### 2. Resolve the import for TypeScript — `tsconfig.json`

`moduleResolution: node` does not read the package `exports` map, so map the specifier
to source (relative to `baseUrl`):

```jsonc
"paths": {
  "@framework/ui": ["../../frappe/ui/src/index.ts"],
  "@framework/ui/*": ["../../frappe/ui/src/*"]
}
```

The `paths` key must match the package name `@framework/ui` (also the key under
`dependencies`) so the specifier resolves the same way in TypeScript and the bundler.

The host app must already provide the peers (`vue`, `vue-router`, `frappe-ui`) — every
Frappe frontend does.

### 3. Dedupe shared singletons — `vite.config.js`

`@framework/ui` ships raw source compiled in place by the host bundler, so its bare
imports of shared singletons (`vue`, `vue-router`, `frappe-ui`, `reka-ui`, `dompurify`)
resolve by realpath into a _second_ copy unless deduped — breaking provide/inject
context (reka-ui especially) and doubling Vue. Add the bundled plugin:

```js
import frameworkUI from "@framework/ui/vite";

export default defineConfig({
  plugins: [frameworkUI()], // pass { dedupe: [...] } to add app-specific singletons
});
```

## Usage

```vue
<script setup lang="ts">
import { Link } from "@framework/ui";
</script>

<template>
  <Link doctype="User" v-model="owner" />
</template>
```

Subpaths work too (via the `./*` export), e.g. `import { FormLayout } from '@framework/ui/FormLayout'`.

## Building desk islands — `@framework/ui/vite/island`

An **island** is an app-provided Vue UI unit that desk mounts in a shadow root against
framework's shared runtime. The preset is how an app builds one. It fixes everything the
mount contract depends on, so an app declares only its entries:

```js
// apps/insights/frontend/build-islands.mjs
import { buildIslands } from "@framework/ui/vite/island";

await buildIslands({
  app: "insights",
  root: import.meta.dirname,
  entries: { insights_dashboard: "src/islands/dashboard.js" },
  production: process.argv.includes("--production"),
  watch: process.argv.includes("--watch"),
});
```

An entry becomes `<name>.island.js` and `<name>.island.css` in `assets.json` — the keys
`frappe.ui.mount_island` resolves, deliberately distinct from the legacy `.bundle.js`
ones. Output lands in `sites/assets/<app>/dist/island/<name>/`. Entry names share one
namespace with every other app's, so prefix them with the app.

What the preset does, and the options that change it:

| | |
| --- | --- |
| **Externals** | The runtime closure stays bare (`vue`, `frappe-ui`, `frappe-ui/charts`, `echarts/core`, …), read from the runtime's own `assets.json` registration — see [ADR-0008](docs/adr/0008-island-externals-come-from-the-runtime-registration-not-a-second-walk.md). Build the runtime first (`bench build --app frappe`); a registration that does not publish every entry the installed frappe-ui exports **fails the build**, because linking against a stale one silently bundles what it fails to name. |
| **CSS** | One extracted stylesheet per island: Tailwind scanning `content` (default `src/**/*.{vue,js,ts,jsx,tsx,html}`), no preflight and no base layer (the runtime sheet carries both), `:root`/`html`/`body` rewritten to `:host`, dark mode on `[data-theme="dark"]`. |
| **Icons** | `~icons/lucide/<name>` works, through frappe-ui's resolver. |
| **Budget** | `budget` bytes of JS + CSS per entry, default 256 kB; over it **fails the build**. Pin it to your own first clean build plus slack. `forbiddenImports` is an optional app-local escape hatch. |
| **Watch** | `watch: true` rebuilds into the same place and re-registers. Firing frappe's `hot_update` is still to come — see the TODO in `vite/island/bench.js`. |

`node ui/vite/island/tests/verify.mjs` builds a fixture island and checks the whole
contract end to end.

## Adding to the package

1. Create the component/utility under `src/`.
2. Re-export it from [`src/index.ts`](src/index.ts) (`export { Foo } from './components/Foo'`).

## Notes & troubleshooting

- **"Failed to resolve import '@framework/ui'"** after a rename or fresh link: re-run
  `yarn install` and restart the dev server so the new symlink enters Vite's module graph.
  Also confirm the import specifier matches the package name `@framework/ui`.
- **`vue`/`vue-router`/`frappe-ui` imports inside this package** are resolved by the host
  app (peers + `resolve.dedupe`), so the package cannot be built or type-checked in
  isolation — work on it from within a consuming app.
