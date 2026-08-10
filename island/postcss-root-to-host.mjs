/**
 * PostCSS plugin: retarget document-level selectors at the shadow host.
 *
 * A shadow tree has no `:root`, `<html>` or `<body>`, so the tokens, preflight
 * and type styles those selectors carry would never reach an island. `:host` is
 * inherited, so it reaches every node in the tree.
 */
const DOCUMENT_ROOTS = /(^|,)\s*(:root|html|body)\b/g;

/** @type {import('postcss').Plugin} */
const rootToHost = {
  postcssPlugin: "island-runtime-root-to-host",
  Rule(rule) {
    if (typeof rule.selector !== "string") return;
    // Leading position only: `body .foo` is a real descendant selector, but
    // `.foo body` cannot match anything a rewrite would fix.
    rule.selector = rule.selector.replace(DOCUMENT_ROOTS, "$1:host");
  },
};

export default rootToHost;
