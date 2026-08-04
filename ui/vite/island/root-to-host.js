// PostCSS plugin: retarget document-level selectors at the shadow host, so the
// tokens and type styles they carry reach an island. `:host` is inherited.
//
// A copy of framework's island/postcss-root-to-host.mjs rather than an import:
// this one ships in an npm package and that one does not.

const DOCUMENT_ROOTS = /(^|,)\s*(:root|html|body)\b/g;

/** @type {import('postcss').Plugin} */
const rootToHost = {
	postcssPlugin: "island-root-to-host",
	Rule(rule) {
		if (typeof rule.selector !== "string") return;
		// Leading position only: `body .foo` is a real descendant selector, but
		// `.foo body` cannot match anything a rewrite would fix.
		rule.selector = rule.selector.replace(DOCUMENT_ROOTS, "$1:host");
	},
};

export default rootToHost;
