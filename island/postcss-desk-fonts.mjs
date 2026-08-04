/**
 * PostCSS plugin: ask for the font families desk actually registers.
 *
 * The runtime never loads frappe-ui's font stylesheet, so its `InterVar` matches
 * no registered face and an island renders in the system font. Desk registers
 * the same typeface as `InterVariable` and `Inter`, and `@font-face` is
 * document-scoped — it already reaches the shadow tree. Only the name is wrong.
 */

/** Optionally quoted, and not the leading half of `InterVariable`. */
const FRAPPE_UI_FONT = /(["']?)InterVar\1(?![\w-])/g;

/** Variable file first, static weights as the fallback desk also registers. */
const DESK_FONTS = "InterVariable, Inter";

/** @type {import('postcss').Plugin} */
const deskFonts = {
  postcssPlugin: "island-runtime-desk-fonts",
  Declaration(decl) {
    if (!/font/i.test(decl.prop) || typeof decl.value !== "string") return;
    FRAPPE_UI_FONT.lastIndex = 0;
    decl.value = decl.value.replace(FRAPPE_UI_FONT, DESK_FONTS);
  },
};

export default deskFonts;
