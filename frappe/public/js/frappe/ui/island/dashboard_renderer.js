/**
 * Which renderer draws a desk dashboard. The conditions behind the answer live
 * server-side, in `frappe/utils/dashboard_renderer.py`.
 *
 * The boot field folds in every condition that does not depend on the
 * reference, so a site without the bridge answers without a round trip.
 *
 * @param {string} reference  What the desk dashboard route carries, verbatim.
 *   Desk never parses it; the picked renderer is what loads from it.
 * @returns {Promise<"insights" | "legacy">}
 */
async function get_dashboard_renderer(reference) {
	if (!frappe.boot?.insights_rendered_doctype) return "legacy";

	return frappe.xcall("frappe.utils.dashboard_renderer.get_renderer_for_reference", {
		reference,
	});
}

frappe.provide("frappe.ui");
frappe.ui.get_dashboard_renderer = get_dashboard_renderer;
