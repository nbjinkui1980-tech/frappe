import importlib
import unittest

import frappe

MODULES = (
	"frappe.tests.test_db",
	"frappe.tests.test_db_query",
	"frappe.tests.test_db_update",
	"frappe.tests.test_query",
	"frappe.tests.test_query_builder",
	"frappe.tests.test_sequence",
	"frappe.desk.page.setup_wizard.test_setup_wizard",
	"frappe.core.doctype.installed_applications.test_installed_applications",
)


def load_tests(loader: unittest.TestLoader, _tests: unittest.TestSuite, _pattern: str | None):
	combined = unittest.TestSuite()
	counts = {}
	for module_name in MODULES:
		suite = loader.loadTestsFromModule(importlib.import_module(module_name))
		count = suite.countTestCases()
		if count <= 0:
			raise AssertionError(f"Database Contract candidate suite is empty: {module_name}")
		counts[module_name] = count
		combined.addTests(suite)

	print(
		f"Database Contract: database={frappe.db.db_type} aggregator={__name__} "
		f"combined_count={combined.countTestCases()} candidate_counts={counts}"
	)
	return combined
