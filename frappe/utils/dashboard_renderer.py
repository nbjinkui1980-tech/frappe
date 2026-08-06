# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE
"""The renderer bridge: Insights or the legacy renderer for a desk dashboard.

Desk dashboards move to Insights across v16, so both renderers exist side by
side for a while and every condition behind that choice lives here.

The flag gates rendering surfaces only — Insights' own app, its content and the
island plumbing ignore it, and Insights knows none of this.

Retirement: in v17 `get_dashboard_renderer` collapses to `return INSIGHTS`, and
the bridge is then deleted with its call sites. No Insights release is needed at
either step.
"""

import frappe
from frappe.utils import cint

# The two answers. `frappe.ui.get_dashboard_renderer` returns the same strings.
INSIGHTS = "insights"
LEGACY = "legacy"

# A site_config.json key rather than a System Settings field: the flag is a
# rollout switch with a known end date, and a conf key leaves no schema behind
# when the bridge goes. Absent means off.
SITE_FLAG = "render_dashboards_with_insights"

INSIGHTS_APP = "insights"
INSIGHTS_DASHBOARD_DOCTYPE = "Insights Dashboard v3"


def get_dashboard_renderer(doctype: str) -> str:
	"""Which renderer draws a dashboard of `doctype`: `INSIGHTS` or `LEGACY`."""
	if doctype != INSIGHTS_DASHBOARD_DOCTYPE:
		return LEGACY

	if not cint(frappe.conf.get(SITE_FLAG)):
		return LEGACY

	# Framework's own installed-apps knowledge, never an Insights import: the
	# bridge has to answer on a site that does not have Insights at all.
	if INSIGHTS_APP not in frappe.get_installed_apps():
		return LEGACY

	return INSIGHTS


@frappe.whitelist()
def get_renderer_for_reference(reference: str) -> str:
	"""Which renderer draws the dashboard a desk route names.

	Framework answers for its own content and stops there, so legacy wins a
	collision and every link written before this route keeps pointing where it
	did. Insights owns resolving its own reference — logical id, slug or docname —
	and owns the state a reference naming nothing lands on.
	"""
	# The bare route names no dashboard. Picking one is the legacy page's own flow.
	if not reference:
		return LEGACY

	if get_dashboard_renderer(INSIGHTS_DASHBOARD_DOCTYPE) == LEGACY:
		return LEGACY

	return LEGACY if frappe.db.exists("Dashboard", reference) else INSIGHTS


def get_insights_rendered_doctype() -> str | None:
	"""The doctype desk renders with Insights, or `None` when the bridge is off.

	Boot carries this rather than the raw conditions, so no page can reassemble
	the decision from parts, and a site without the bridge answers on the client
	with no round trip.
	"""
	return (
		INSIGHTS_DASHBOARD_DOCTYPE if get_dashboard_renderer(INSIGHTS_DASHBOARD_DOCTYPE) == INSIGHTS else None
	)
