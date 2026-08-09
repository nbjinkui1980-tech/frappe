# Island externals come from the runtime's registration, not a second dependency walk

The island preset (`@framework/ui/vite/island`) must leave exactly one set of
bare imports unbundled: the runtime closure — `vue`, `vue-router`, `frappe-ui`
and everything frappe-ui drags in — because desk's import map is what links them
at page load. Anything in that set which the preset bundles instead is a second
copy of Vue on the page; anything outside it which the preset externalises is a
specifier the import map cannot resolve, and the island fails to load.

So the set has to be exact, and the preset reads it out of **assets.json**: every
key ending `.runtime.js`, with the suffix dropped. That is the same enumeration
framework's runtime build wrote and the same one desk turns into the import map.
One list, three consumers, no way to drift. The cost is an ordering dependency —
the runtime must be built before an island is — which the preset reports as a
build error naming `bench build --app frappe`. That dependency is real anyway: an
island without a runtime has nothing to mount against.

The alternative the foundation spec suggests, walking the installed frappe-ui's
`package.json` dependencies transitively, was measured against the built runtime
and is not the same list:

| | packages | entry specifiers |
| --- | --- | --- |
| runtime registration | 127 | 405 |
| transitive `dependencies` walk | 250 | n/a |

The walk is a strict superset — it misses nothing, but it adds 123 packages,
because a `dependencies` entry says nothing about whether the package is
*imported by a browser*. frappe-ui declares its build tooling there
(`prettier`, `typescript`, `unplugin-*`, `ora`, `postcss`) and packages it ships
without importing (`fuzzysort`, `lucide-static`). Externalising `fuzzysort`
breaks any island that uses it; externalising `lucide-static` breaks every island
with an icon. A `package.json` walk also cannot produce a subpath specifier at
all — `@tiptap/pm/state`, `dayjs/esm/plugin/utc`, `frappe-ui/code-editor` — and
282 of the runtime's 405 keys are subpaths.

Matching is on the whole specifier, not the package name, for the same
fail-safe reason. `echarts` is registered and `echarts/core` is not; treating the
subpath as external would produce a broken island, while bundling it produces
merely a fat one — and fat is what the size budget catches. The preset warns when
it bundles a subpath of a closure package, since that is almost always a
mis-written import.

## Amendment: the reader checks that the registration is current

"One list, three consumers, no way to drift" holds between the three consumers.
It says nothing about the list and the tree it was written from, and that is the
gap a chart island fell through.

frappe-ui grew a `./charts` entry. Nobody rebuilt the runtime, so its
registration named `frappe-ui` and not `frappe-ui/charts`, which reads exactly
like an entry outside the closure. Insights imported `frappe-ui/charts`, the
preset bundled it, and with it came `echarts/core`, `echarts/charts`,
`echarts/components`, `echarts/features` and `echarts/renderers` — a second
copy of echarts inside the island. The chart entry weighed 762.2 kB against a
168 kB budget, 86% of it echarts, and the only thing that objected was the
budget. echarts keeps its renderers, series and registered geographies in module
state, so the duplicate was a correctness bug as well as a size one, and a
smaller package in the same position would have shipped in silence.

The preset therefore refuses a registration that does not publish every
browser-facing entry of the frappe-ui it resolves for itself, and names
`bench build --app frappe`. The entry set is the one part of the closure that is
declared rather than walked, so it is the one part this side can check without
redoing the walk this ADR rejects. `frappeUiEntries` is now the single
definition of that set: the runtime build seeds its roots from it and the preset
checks against it, so an entry the runtime deliberately skips can never read as
an entry it is missing. Drift deeper in — frappe-ui reaching for a new subpath
of a package it already uses — stays the warning's job.

Two alternatives were measured and rejected.

**Publish a package's whole `exports` map** instead of the subpaths the closure
imports. echarts declares 96 entry points and three wildcards; the entries
include six prebuilt `dist/` bundles and every `lib/chart/*` and `lib/component/*`
module, so the runtime would build megabytes nothing imports and still could not
enumerate `./theme/*`. dayjs, whose `dayjs/esm/plugin/*` subpaths an island does
reach for, declares no `exports` map at all, so the idea buys nothing there. An
export map is a good thing to check a registration against and a bad thing to
build one from.

**Hand-list the subpaths a chart island needs** in the runtime build. That is
the list this ADR exists to avoid, and it goes stale the next time any consumer
imports something new.

Neither the check nor the walk covers what a closure package publishes *because
another consumer asked for it*. `grid-layout-plus` and `interactjs` are in the
closure only because `frappe-ui/drive` imports them, and Insights' dashboard
island borrows both; the day Drive changes grid libraries that island gains
127 kB with no warning. Nothing about the closure promises otherwise, and an
island that wants a package on its own terms should depend on it and pay for it.
