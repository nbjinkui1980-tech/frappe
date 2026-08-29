# Copyright (c) 2026, Frappe Technologies and Contributors
# See license.txt

from frappe.database import delete_duckdb_file, get_duckdb
from frappe.tests import IntegrationTestCase

# On IntegrationTestCase, the doctype test records and all
# link-field test record dependencies are recursively loaded
# Use these module variables to add/remove to/from that list
EXTRA_TEST_RECORD_DEPENDENCIES = []  # eg. ["User"]
IGNORE_TEST_RECORD_DEPENDENCIES = []  # eg. ["User"]


class IntegrationTestDuckDBSync(IntegrationTestCase):
	"""
	Integration tests for DuckDBSync.
	Use this class for testing interactions between multiple components.
	"""

	def test_analytical_read(self):
		filename = "test_duckdb_analytical_read.duckdb"
		self.addCleanup(delete_duckdb_file, filename)
		connection = get_duckdb(False, filename)
		self.addCleanup(connection.close)

		result = connection.sql(
			"""select category, sum(amount) from (values ('books', 10), ('books', 15), ('music', 20))
			as sales(category, amount) group by category order by category"""
		).fetchall()

		self.assertEqual(result, [("books", 25), ("music", 20)])
