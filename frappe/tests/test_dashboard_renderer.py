# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE
from contextlib import contextmanager
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils.dashboard_renderer import (
	INSIGHTS,
	INSIGHTS_APP,
	INSIGHTS_DASHBOARD_DOCTYPE,
	LEGACY,
	SITE_FLAG,
	get_dashboard_renderer,
	get_insights_rendered_doctype,
	get_renderer_for_reference,
)


@contextmanager
def site(*, installed: bool, flag: bool):
	apps = ["frappe", INSIGHTS_APP] if installed else ["frappe"]
	with (
		patch.object(frappe, "get_installed_apps", return_value=apps),
		patch.dict(frappe.local.conf, {SITE_FLAG: 1 if flag else 0}),
	):
		yield


class TestDashboardRenderer(IntegrationTestCase):
	def test_condition_table(self):
		# Insights renders a dashboard only when all three conditions hold.
		cases = {
			(INSIGHTS_DASHBOARD_DOCTYPE, True, True): INSIGHTS,
			(INSIGHTS_DASHBOARD_DOCTYPE, True, False): LEGACY,
			(INSIGHTS_DASHBOARD_DOCTYPE, False, True): LEGACY,
			(INSIGHTS_DASHBOARD_DOCTYPE, False, False): LEGACY,
			("Dashboard", True, True): LEGACY,
			("Dashboard", True, False): LEGACY,
			("Dashboard", False, True): LEGACY,
			("Dashboard", False, False): LEGACY,
		}

		for (doctype, installed, flag), expected in cases.items():
			with (
				self.subTest(doctype=doctype, installed=installed, flag=flag),
				site(installed=installed, flag=flag),
			):
				self.assertEqual(get_dashboard_renderer(doctype), expected)

	def test_flag_is_off_when_the_site_never_set_it(self):
		with (
			patch.object(frappe, "get_installed_apps", return_value=["frappe", INSIGHTS_APP]),
			patch.dict(frappe.local.conf),
		):
			frappe.local.conf.pop(SITE_FLAG, None)
			self.assertEqual(get_dashboard_renderer(INSIGHTS_DASHBOARD_DOCTYPE), LEGACY)

	def test_an_unrelated_doctype_gets_the_legacy_renderer(self):
		with site(installed=True, flag=True):
			self.assertEqual(get_dashboard_renderer("Workspace"), LEGACY)
			self.assertEqual(get_dashboard_renderer(""), LEGACY)

	def test_a_reference_naming_a_legacy_dashboard_keeps_the_legacy_renderer(self):
		# Only the name is looked up, so the dashboard needs no charts.
		dashboard = frappe.get_doc(doctype="Dashboard", dashboard_name=frappe.generate_hash()).insert(
			ignore_mandatory=True
		)
		with site(installed=True, flag=True):
			self.assertEqual(get_renderer_for_reference(dashboard.name), LEGACY)

	def test_any_other_reference_goes_to_insights_unresolved(self):
		# Framework does not look a reference up in Insights, so a slug, a logical
		# id and a reference that names nothing all answer the same: Insights, which
		# is what resolves it and what draws the nothing-there state.
		with site(installed=True, flag=True):
			for reference in ("sales-performance", "insights/sales-performance", "no-such-thing"):
				with self.subTest(reference=reference):
					self.assertEqual(get_renderer_for_reference(reference), INSIGHTS)

	def test_the_bare_route_gets_the_legacy_renderer(self):
		# `/app/dashboard-view` names no dashboard; picking one is the legacy flow.
		with site(installed=True, flag=True):
			self.assertEqual(get_renderer_for_reference(""), LEGACY)

	def test_a_reference_gets_the_legacy_renderer_while_the_bridge_is_off(self):
		for installed, flag in ((True, False), (False, True), (False, False)):
			with self.subTest(installed=installed, flag=flag), site(installed=installed, flag=flag):
				self.assertEqual(get_renderer_for_reference("sales-performance"), LEGACY)

	def test_boot_names_the_doctype_insights_renders(self):
		with site(installed=True, flag=True):
			self.assertEqual(get_insights_rendered_doctype(), INSIGHTS_DASHBOARD_DOCTYPE)

	def test_boot_carries_nothing_while_the_bridge_is_off(self):
		for installed, flag in ((True, False), (False, True), (False, False)):
			with self.subTest(installed=installed, flag=flag), site(installed=installed, flag=flag):
				self.assertIsNone(get_insights_rendered_doctype())

	def test_bridge_reaches_the_browser_through_boot(self):
		# The client half answers from this field alone while the bridge is off, so
		# boot has to carry it -- and outside the boot cache, so flipping the flag
		# lands.
		frappe.local.request = None
		self.addCleanup(lambda: delattr(frappe.local, "request"))

		with site(installed=True, flag=True):
			self.assertEqual(frappe.sessions.get().insights_rendered_doctype, INSIGHTS_DASHBOARD_DOCTYPE)

		with site(installed=True, flag=False):
			self.assertIsNone(frappe.sessions.get().insights_rendered_doctype)
