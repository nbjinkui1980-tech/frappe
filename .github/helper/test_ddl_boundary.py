import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("ddl_boundary", Path(__file__).with_name("ddl_boundary.py"))
ddl_boundary = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(ddl_boundary)


class DDLBoundaryTest(unittest.TestCase):
	def check(self, source: str, path: str = "frappe/api.py") -> list[str]:
		return ddl_boundary.check_source(source, path)

	def test_allows_exact_boundaries(self):
		self.assertFalse(self.check('frappe.db.sql_ddl("DROP TABLE x")', "frappe/database/database.py"))
		self.assertFalse(self.check('frappe.db.sql("DROP TABLE x")', "frappe/patches/v17/drop_x.py"))
		self.assertFalse(self.check("frappe.db.sql_ddl(query)", "frappe/tests/test_database.py"))

	def test_transform_database_is_the_only_allowed_commands_utils_function(self):
		source = """
def transform_database():
    frappe.db.sql_ddl(query)

def other():
    frappe.db.sql_ddl(query)
"""
		violations = self.check(source, "frappe/commands/utils.py")
		self.assertEqual(len(violations), 1)
		self.assertIn(":6:", violations[0])

	def test_rejects_sql_ddl_even_with_pg_ok(self):
		violations = self.check("frappe.db.sql_ddl(query)  # pg-ok")
		self.assertEqual(len(violations), 1)

	def test_rejects_static_multiline_ddl(self):
		violations = self.check('frappe.db.sql(f"""\nALTER TABLE `tab{x}`\nDROP COLUMN y\n""")')
		self.assertEqual(len(violations), 1)

	def test_rejects_ddl_after_leading_sql_comments(self):
		for prefix in ("-- reason\n", "/* reason */", "\n-- reason\n/* detail */\n"):
			with self.subTest(prefix=prefix):
				self.assertEqual(len(self.check(f'frappe.db.sql("""{prefix}DROP TABLE tabX""")')), 1)
		self.assertFalse(self.check('frappe.db.sql("""-- DROP TABLE tabX\nSELECT 1""")'))

	def test_allows_dynamic_sql_and_non_ddl(self):
		self.assertFalse(self.check("frappe.db.sql(query)"))
		self.assertFalse(self.check('frappe.db.sql("SELECT name FROM tabUser")'))


if __name__ == "__main__":
	unittest.main()
