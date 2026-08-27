# Copyright (c) 2020, Frappe Technologies and Contributors
# License: MIT. See LICENSE

from unittest.mock import MagicMock, patch

import frappe
from frappe.core.doctype.installed_applications.installed_applications import (
	InstalledApplications,
	InvalidAppOrder,
	update_installed_apps_order,
)
from frappe.tests import IntegrationTestCase, UnitTestCase
from frappe.utils import get_attr


class TestInstalledApplications(IntegrationTestCase):
	def test_order_change(self):
		installed_apps = frappe.get_installed_apps(_ensure_on_bench=True)
		update_installed_apps_order(installed_apps)
		self.assertRaises(InvalidAppOrder, update_installed_apps_order, [])
		self.assertRaises(InvalidAppOrder, update_installed_apps_order, [*installed_apps, "deepmind"])


class TestCurrentApplicationIdentity(UnitTestCase):
	def test_setup_completion_prefers_anydeals_and_falls_back_to_erpnext(self):
		for installed_apps, expected in (
			(["frappe", "anydeals_erp"], ["frappe", "anydeals_erp"]),
			(["frappe", "erpnext"], ["frappe", "erpnext"]),
		):
			with (
				self.subTest(installed_apps=installed_apps),
				patch.object(frappe.db, "table_exists", return_value=True),
				patch("frappe.apps.get_disabled_apps", return_value=[]),
				patch.object(frappe, "get_installed_apps", return_value=installed_apps),
				patch.object(frappe, "get_all", return_value=[1, 1]) as get_all,
			):
				self.assertTrue(frappe.is_setup_complete.__wrapped__())

			get_all.assert_called_once_with(
				"Installed Application",
				{"app_name": ("in", expected)},
				pluck="is_setup_complete",
			)

	def test_installed_applications_treats_anydeals_as_the_current_erp_wizard(self):
		document = MagicMock()
		document.get_app_wise_setup_details.return_value = {}
		rows = []
		document.append.side_effect = lambda key, value: rows.append(value)

		with (
			patch.object(frappe, "get_disabled_apps", return_value=[]),
			patch.object(frappe, "get_installed_apps", return_value=["frappe", "anydeals_erp"]),
			patch.object(
				frappe.utils,
				"get_installed_apps_info",
				return_value=[
					{"app_name": "frappe", "version": "17"},
					{"app_name": "anydeals_erp", "version": "17"},
					{"app_name": "payments", "version": "1"},
				],
			),
			patch(
				"frappe.core.doctype.installed_applications.installed_applications.has_non_admin_user",
				return_value=False,
			),
			patch(
				"frappe.core.doctype.installed_applications.installed_applications.has_company",
				return_value=True,
			),
			patch.object(frappe, "clear_cache"),
			patch.object(frappe, "is_setup_complete", return_value=True),
			patch.object(frappe.db, "set_single_value"),
		):
			InstalledApplications.update_versions(document)

		self.assertEqual(
			[(row["app_name"], row["has_setup_wizard"], row["is_setup_complete"]) for row in rows],
			[("frappe", 1, 0), ("anydeals_erp", 1, 1), ("payments", 0, 0)],
		)

	def test_get_attr_rewrites_only_the_legacy_app_prefix(self):
		module = MagicMock(target=object())
		with (
			patch.object(frappe, "get_installed_apps", return_value=["frappe", "anydeals_erp"]),
			patch("frappe.utils.get_module", return_value=module) as get_module,
		):
			self.assertIs(get_attr("erpnext.module.target"), module.target)

		get_module.assert_called_once_with("anydeals_erp.module")
