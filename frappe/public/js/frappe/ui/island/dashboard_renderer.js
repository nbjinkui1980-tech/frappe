/**
 * Which renderer draws a desk dashboard. The conditions behind the answer live
 * server-side, in `frappe/utils/dashboard_renderer.py`.
 *
 *     if (frappe.ui.get_dashboard_renderer(doc) === "insights") {
 *         await frappe.ui.mount_island("insights.dashboard", el, {
 *             props: { dashboard: doc.name },
 *         });
 *     } else {
 *         // the legacy dashboard renderer
 *     }
 *
 * Three conditions decide it: Insights is installed, the site flag
 * `render_dashboards_with_insights` is on, and the document is Insights content
 * rather than a legacy `Dashboard`. All three are folded server-side into one
 * boot field (see `frappe/utils/dashboard_renderer.py`), so a page branches once
 * and never sees a condition. It sits beside the island loader because the
 * Insights answer is mounted as an island.
 *
 * Retirement: in v17 this body becomes `return "insights"`, and the bridge is
 * then deleted along with its call sites. No Insights release is needed at
 * either step.
 */

/**
 * @param {{ doctype: string, name?: string }} doc  The routed document, as the
 *   desk dashboard route knows it. Only `doctype` picks the renderer; `name` is
 *   what the picked renderer then loads.
 * @returns {"insights" | "legacy"}
 */
function get_dashboard_renderer(doc) {
	const insights_doctype = frappe.boot?.insights_rendered_doctype;
	return insights_doctype && doc?.doctype === insights_doctype ? "insights" : "legacy";
}

frappe.provide("frappe.ui");
frappe.ui.get_dashboard_renderer = get_dashboard_renderer;
