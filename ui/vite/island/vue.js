// The Vue SFC plugin, configured the one way an island may compile a template.
//
// Comments are dropped, always. An island is served against the runtime's Vue,
// which is the production build, and a template that keeps its comments renders
// a component as a fragment: the comment node, then the root element. Only the
// development runtime walks that fragment to find the real root, so under the
// production one every fallthrough attribute — `class`, `style`, listeners —
// lands on nothing and is dropped without a warning. `<ChartCard class="h-full">`
// silently lost its height that way, and 33 components in frappe-ui alone open
// their template with a comment.
//
// The compiler decides this off the build mode, so leaving it unset makes a
// shipped artifact depend on how it was built. Islands ship one way.

import vue from "@vitejs/plugin-vue";

/**
 * @param {import('@vitejs/plugin-vue').Options} [options]
 * @returns {import('vite').Plugin[]}
 */
export function islandVue(options = {}) {
	return vue({
		...options,
		template: {
			...options.template,
			compilerOptions: { ...options.template?.compilerOptions, comments: false },
		},
	});
}
