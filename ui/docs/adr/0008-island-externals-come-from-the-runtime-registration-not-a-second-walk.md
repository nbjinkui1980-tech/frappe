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
