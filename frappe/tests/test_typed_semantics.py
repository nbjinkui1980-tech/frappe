# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE
import datetime
import json
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase, UnitTestCase
from frappe.types.typed_semantics import (
	normalize_docfield_value,
	normalize_typed_row,
	typed_semantics_v2_enabled,
)
from frappe.utils.data import cast


def enable_v2():
	return patch.object(frappe, "get_site_config", lambda *args, **kwargs: {"typed_semantics_v2": 1})


def disable_v2():
	return patch.object(frappe, "get_site_config", lambda *args, **kwargs: {})


class TestSwitch(UnitTestCase):
	def test_defaults_off(self):
		self.assertFalse(typed_semantics_v2_enabled())

	def test_switch_on(self):
		with enable_v2():
			self.assertTrue(typed_semantics_v2_enabled())

	def test_explicit_falsy_off(self):
		with disable_v2():
			self.assertFalse(typed_semantics_v2_enabled())

	def test_no_site_context_defaults_off(self):
		with patch.object(frappe, "get_site_config", side_effect=Exception("no site")):
			self.assertFalse(typed_semantics_v2_enabled())


class TestNormalizeDocfieldValue(UnitTestCase):
	def test_typed_empty(self):
		for fieldtype in ("Date", "Datetime", "Time", "Link", "JSON"):
			self.assertIsNone(normalize_docfield_value(fieldtype, ""))
		for fieldtype in ("Data", "Text", "Int", "Select", "Check"):
			self.assertEqual(normalize_docfield_value(fieldtype, ""), "")

	def test_json_objects(self):
		self.assertEqual(normalize_docfield_value("JSON", '{"a": 1}'), {"a": 1})
		self.assertEqual(normalize_docfield_value("JSON", "[1, 2]"), [1, 2])
		self.assertIsNone(normalize_docfield_value("JSON", "null"))
		obj = {"a": 1}
		self.assertIs(normalize_docfield_value("JSON", obj), obj)
		self.assertIsNone(normalize_docfield_value("JSON", None))
		for value in ("not json", "1", "true", 1, True):
			with self.subTest(value=value), self.assertRaises((TypeError, ValueError)):
				normalize_docfield_value("JSON", value)

	def test_time(self):
		self.assertEqual(
			normalize_docfield_value("Time", "01:30:00"), datetime.timedelta(hours=1, minutes=30)
		)
		zero = datetime.timedelta(0)
		self.assertIs(normalize_docfield_value("Time", zero), zero)

	def test_normalize_typed_row(self):
		meta = frappe._dict()
		fields = {
			"arguments": frappe._dict(fieldtype="JSON"),
			"ref_doctype": frappe._dict(fieldtype="Link"),
			"queue": frappe._dict(fieldtype="Data"),
		}
		meta.get_field = fields.get
		row = {"arguments": '{"a": 1}', "ref_doctype": "", "queue": "", "unrelated": ""}
		normalize_typed_row(row, meta)
		self.assertEqual(row["arguments"], {"a": 1})
		self.assertIsNone(row["ref_doctype"])
		self.assertEqual(row["queue"], "")
		self.assertEqual(row["unrelated"], "")


class TestCastTime(UnitTestCase):
	def test_legacy_empty_is_zero_duration(self):
		with disable_v2():
			self.assertEqual(cast("Time", ""), datetime.timedelta(0))
			self.assertEqual(cast("Time", None), datetime.timedelta(0))

	def test_v2_empty_is_none(self):
		with enable_v2():
			self.assertIsNone(cast("Time", ""))
			self.assertIsNone(cast("Time", None))

	def test_v2_zero_duration_and_text_preserved(self):
		with enable_v2():
			self.assertEqual(cast("Time", datetime.timedelta(0)), datetime.timedelta(0))
			self.assertEqual(cast("Time", "00:00:00"), datetime.timedelta(0))
			self.assertEqual(cast("Time", "01:30:00"), datetime.timedelta(hours=1, minutes=30))


class TestTypedQueryResultContainers(UnitTestCase):
	def test_as_list_preserves_inner_lists(self):
		from frappe.query_builder.utils import apply_typed_normalization

		result = [[""]]
		normalized = apply_typed_normalization(
			([(0, "ref_doctype", "Link")], None),
			result,
			as_dict=False,
			pluck=False,
		)
		self.assertIsInstance(normalized[0], list)
		self.assertIsNone(normalized[0][0])

	def test_tuple_rows_remain_tuples(self):
		from frappe.query_builder.utils import apply_typed_normalization

		normalized = apply_typed_normalization(
			([(0, "ref_doctype", "Link")], None),
			[("",)],
			as_dict=False,
			pluck=False,
		)
		self.assertIsInstance(normalized[0], tuple)
		self.assertIsNone(normalized[0][0])

	def test_pluck_remains_flat(self):
		from frappe.query_builder.utils import apply_typed_normalization

		self.assertEqual(
			apply_typed_normalization(
				([(0, "ref_doctype", "Link")], None),
				[""],
				as_dict=False,
				pluck=True,
			),
			[None],
		)


class TestPlanClassification(UnitTestCase):
	def _meta(self, fields):
		meta = frappe._dict(fields=fields)
		meta.get_field = lambda fieldname: next(
			(field for field in fields if field.fieldname == fieldname), None
		)
		return meta

	def test_customize_form_single_is_report_only(self):
		from frappe.database import typed_semantics_migration

		customize_meta = self._meta([frappe._dict(fieldname="link_filters", fieldtype="JSON")])
		with (
			patch.object(typed_semantics_migration, "_information_schema_columns", return_value={}),
			patch.object(frappe, "get_all", return_value=[]),
			patch.object(frappe, "get_meta", return_value=customize_meta),
			patch.object(frappe, "get_doctype_app", return_value="frappe"),
		):
			writable, report_only, unknown = typed_semantics_migration._classify_fields()
		self.assertFalse(writable)
		self.assertFalse(unknown)
		self.assertEqual(
			[(entry["doctype"], entry["column"], entry["reason"]) for entry in report_only],
			[("Customize Form", "link_filters", "parked_by_contract")],
		)

	def test_duplicate_metadata_column_has_one_write_target(self):
		from frappe.database import typed_semantics_migration

		duplicate_fields = [
			frappe._dict(fieldname="reference", fieldtype="Link"),
			frappe._dict(fieldname="reference", fieldtype="Link"),
		]
		metas = {
			"Duplicate Meta": self._meta(duplicate_fields),
			"Customize Form": self._meta([frappe._dict(fieldname="link_filters", fieldtype="JSON")]),
		}
		with (
			patch.object(
				typed_semantics_migration,
				"_information_schema_columns",
				return_value={("tabDuplicate Meta", "reference"): True},
			),
			patch.object(
				frappe,
				"get_all",
				return_value=[frappe._dict(name="Duplicate Meta", module="Core")],
			),
			patch.object(frappe, "get_meta", side_effect=metas.get),
			patch.object(frappe, "get_doctype_app", return_value="frappe"),
		):
			writable, _, unknown = typed_semantics_migration._classify_fields()
		self.assertFalse(unknown)
		self.assertEqual(
			[(entry["table"], entry["column"]) for entry in writable], [("tabDuplicate Meta", "reference")]
		)

	def test_json_scanner_rejects_scalars_on_either_driver_shape(self):
		from frappe.database import typed_semantics_migration

		rows = [
			frappe._dict(name="object-text", payload='{"ok": true}'),
			frappe._dict(name="object-native", payload={"ok": True}),
			frappe._dict(name="scalar-text", payload="1"),
			frappe._dict(name="scalar-native", payload=1),
		]
		with patch.object(frappe.db, "sql", return_value=rows):
			invalid = typed_semantics_migration._find_invalid_json_rows(
				"Typed JSON", "tabTyped JSON", "payload"
			)
		self.assertEqual([entry["name"] for entry in invalid], ["scalar-text", "scalar-native"])

	def _first_party_standard_and_custom(self):
		"""One standard and one custom DocType, both attributed to a first-party app."""
		from frappe.database import typed_semantics_migration

		metas = {
			"Standard Meta": self._meta([frappe._dict(fieldname="reference", fieldtype="Link")]),
			"Custom Meta": self._meta([frappe._dict(fieldname="payload", fieldtype="Link")]),
			"Customize Form": self._meta([frappe._dict(fieldname="link_filters", fieldtype="JSON")]),
		}
		rows = [
			frappe._dict(name="Standard Meta", module="Core", custom=0),
			frappe._dict(name="Custom Meta", module="Core", custom=1),
		]
		columns = {
			("tabStandard Meta", "reference"): True,
			("tabCustom Meta", "payload"): True,
		}
		return typed_semantics_migration, metas, rows, columns

	def test_first_party_standard_writable_custom_report_only(self):
		mod, metas, rows, columns = self._first_party_standard_and_custom()
		with (
			patch.object(mod, "_information_schema_columns", return_value=columns),
			patch.object(frappe, "get_all", return_value=rows),
			patch.object(frappe, "get_meta", side_effect=metas.get),
			patch.object(frappe, "get_doctype_app", return_value="frappe"),
		):
			writable, report_only, unknown = mod._classify_fields()

		self.assertFalse(unknown)
		self.assertEqual(
			[(entry["table"], entry["column"]) for entry in writable],
			[("tabStandard Meta", "reference")],
		)
		custom_entries = [entry for entry in report_only if entry["doctype"] == "Custom Meta"]
		self.assertEqual(len(custom_entries), 1)
		self.assertEqual(custom_entries[0]["app"], "frappe")
		self.assertEqual(custom_entries[0]["reason"], "custom_doctype")

	def test_build_plan_and_apply_never_write_custom_tables(self):
		mod, metas, rows, columns = self._first_party_standard_and_custom()
		queries = []

		def fake_sql(query, *args, **kwargs):
			queries.append(query)
			if query.startswith("SELECT COUNT"):
				return [(0,)]
			return []

		with (
			patch.object(mod, "_information_schema_columns", return_value=columns),
			patch.object(mod, "now_datetime", lambda: datetime.datetime(2026, 8, 30)),
			patch.object(frappe, "get_all", return_value=rows),
			patch.object(frappe, "get_meta", side_effect=metas.get),
			patch.object(frappe, "get_doctype_app", return_value="frappe"),
			patch.object(frappe.db, "sql", side_effect=fake_sql),
			patch.object(frappe.db, "commit", lambda: None),
			patch.object(frappe.db, "rollback", lambda: None),
			patch.object(frappe.db, "_cursor", frappe._dict(rowcount=0), create=True),
		):
			plan = mod.build_plan()
			self.assertEqual(plan["backfill_targets"], [{"table": "tabStandard Meta", "column": "reference"}])
			self.assertEqual(plan["classification"]["writable"], 1)
			mod.apply_plan(plan)

		updates = [query for query in queries if query.startswith("UPDATE")]
		self.assertTrue(updates)
		self.assertTrue(all("tabStandard Meta" in query for query in updates))
		self.assertTrue(all("tabCustom Meta" not in query for query in queries))

	def test_invalid_json_location_query_orders_by_name(self):
		from frappe.database import typed_semantics_migration

		captured = []

		def fake_sql(query, *args, **kwargs):
			captured.append(query)
			return []

		with patch.object(frappe.db, "sql", side_effect=fake_sql):
			typed_semantics_migration._find_invalid_json_rows("Typed JSON", "tabTyped JSON", "payload")
		self.assertIn("ORDER BY `name`", captured[0])

	def test_classification_doctype_query_is_stably_ordered(self):
		from frappe.database import typed_semantics_migration

		captured = {}

		def fake_get_all(doctype, **kwargs):
			captured.update(kwargs)
			return []

		with (
			patch.object(typed_semantics_migration, "_information_schema_columns", return_value={}),
			patch.object(frappe, "get_all", side_effect=fake_get_all),
			patch.object(frappe, "get_meta", return_value=self._meta([])),
		):
			typed_semantics_migration._classify_fields()
		self.assertEqual(captured.get("order_by"), "name")


class TestPlanIntegrity(UnitTestCase):
	def test_missing_hash_rejected(self):
		from frappe.database.typed_semantics_migration import verify_plan

		with self.assertRaises(ValueError):
			verify_plan({"classification": {}})

	def _signed_plan(self, **overrides):
		from frappe.database.typed_semantics_migration import _canonical_hash

		plan = {
			"frappe_version": frappe.__version__,
			"db_type": "mariadb",
			"classification": {"writable": 0, "report_only": 0, "unknown": 0},
			"writable_columns": [],
			"report_only_fields": [],
			"unknown_fields": [],
			"backfill_targets": [],
			"schema_digest": "x",
		}
		plan.update(overrides)
		plan["plan_hash"] = _canonical_hash(plan)
		return plan

	def test_tampered_plan_rejected(self):
		from frappe.database.typed_semantics_migration import verify_plan

		plan = self._signed_plan()
		plan["classification"]["writable"] = 99
		with self.assertRaises(ValueError):
			verify_plan(plan)

	def test_unknown_fields_fail_closed(self):
		from frappe.database.typed_semantics_migration import verify_plan

		plan = self._signed_plan(classification={"writable": 0, "report_only": 0, "unknown": 1})
		with self.assertRaises(ValueError):
			verify_plan(plan)

	def test_unknown_fail_closed_with_custom_report_only(self):
		from frappe.database.typed_semantics_migration import verify_plan

		plan = self._signed_plan(
			classification={"writable": 0, "report_only": 1, "unknown": 1},
			report_only_fields=[
				{
					"doctype": "Custom Meta",
					"table": "tabCustom Meta",
					"column": "payload",
					"fieldtype": "Link",
					"app": "frappe",
					"reason": "custom_doctype",
				}
			],
		)
		with self.assertRaisesRegex(ValueError, "unknown"):
			verify_plan(plan)

	def test_invalid_json_fails_closed(self):
		from frappe.database.typed_semantics_migration import verify_plan

		plan = self._signed_plan(writable_columns=[{"invalid_json_rows": 2}])
		with self.assertRaises(ValueError):
			verify_plan(plan)

	def test_self_signed_write_target_fails_closed(self):
		from frappe.database import typed_semantics_migration

		current = self._signed_plan()
		forged = self._signed_plan(backfill_targets=[{"table": "tabUser", "column": "name"}])
		with patch.object(typed_semantics_migration, "build_plan", return_value=current):
			with self.assertRaisesRegex(ValueError, "plan source mismatch"):
				typed_semantics_migration.verify_plan(forged)

	def test_source_rows_changed_after_dry_run_fail_closed(self):
		from frappe.database import typed_semantics_migration

		column = {
			"doctype": "Background Task",
			"table": "tabBackground Task",
			"column": "ref_doctype",
			"fieldtype": "Link",
			"nullable": True,
			"empty_string_rows": 1,
			"empty_string_source_digest": "source-a",
			"invalid_json_rows": 0,
			"invalid_json_locations": [],
		}
		plan = self._signed_plan(
			classification={"writable": 1, "report_only": 0, "unknown": 0},
			writable_columns=[column],
			backfill_targets=[{"table": column["table"], "column": column["column"]}],
		)
		current = self._signed_plan(
			classification=plan["classification"],
			writable_columns=[column | {"empty_string_rows": 2}],
			backfill_targets=plan["backfill_targets"],
		)
		with patch.object(typed_semantics_migration, "build_plan", return_value=current):
			with self.assertRaisesRegex(ValueError, "plan source mismatch"):
				typed_semantics_migration.verify_plan(plan)

	def test_source_identity_changed_with_same_count_fails_closed(self):
		from frappe.database import typed_semantics_migration

		column = {
			"doctype": "Background Task",
			"table": "tabBackground Task",
			"column": "ref_doctype",
			"fieldtype": "Link",
			"nullable": True,
			"empty_string_rows": 1,
			"empty_string_source_digest": "source-a",
			"invalid_json_rows": 0,
			"invalid_json_locations": [],
		}
		plan = self._signed_plan(
			classification={"writable": 1, "report_only": 0, "unknown": 0},
			writable_columns=[column],
			backfill_targets=[{"table": column["table"], "column": column["column"]}],
		)
		current = self._signed_plan(
			classification=plan["classification"],
			writable_columns=[column | {"empty_string_source_digest": "source-b"}],
			backfill_targets=plan["backfill_targets"],
		)
		with patch.object(typed_semantics_migration, "build_plan", return_value=current):
			with self.assertRaisesRegex(ValueError, "plan source mismatch"):
				typed_semantics_migration.verify_plan(plan)

	def test_already_applied_plan_is_valid_for_zero_change_retry(self):
		from frappe.database import typed_semantics_migration

		column = {
			"doctype": "Background Task",
			"table": "tabBackground Task",
			"column": "ref_doctype",
			"fieldtype": "Link",
			"nullable": True,
			"empty_string_rows": 1,
			"empty_string_source_digest": "source-a",
			"invalid_json_rows": 0,
			"invalid_json_locations": [],
		}
		plan = self._signed_plan(
			classification={"writable": 1, "report_only": 0, "unknown": 0},
			writable_columns=[column],
			backfill_targets=[{"table": column["table"], "column": column["column"]}],
		)
		current = self._signed_plan(
			classification=plan["classification"],
			writable_columns=[
				column
				| {
					"empty_string_rows": 0,
					"empty_string_source_digest": typed_semantics_migration._canonical_hash([]),
				}
			],
			backfill_targets=plan["backfill_targets"],
		)
		with patch.object(typed_semantics_migration, "build_plan", return_value=current):
			typed_semantics_migration.verify_plan(plan)

	def test_invalid_json_added_after_dry_run_fails_closed(self):
		from frappe.database import typed_semantics_migration

		plan = self._signed_plan()
		current = self._signed_plan(
			writable_columns=[
				{
					"invalid_json_rows": 1,
					"invalid_json_locations": [
						{"doctype": "Background Task", "name": "TASK-1", "fieldname": "arguments"}
					],
				}
			]
		)
		with patch.object(typed_semantics_migration, "build_plan", return_value=current):
			with self.assertRaisesRegex(ValueError, "current database contains invalid JSON"):
				typed_semantics_migration.verify_plan(plan)


class TestTypedSemanticsV2Integration(IntegrationTestCase):
	TEST_DOCTYPE = "Background Task"

	def _make_doc(self):
		doc = frappe.get_doc(
			{
				"doctype": self.TEST_DOCTYPE,
				"task_id": frappe.generate_hash(length=10),
				"task_name": "test-typed-semantics",
				"status": "Queued",
				"user": "Administrator",
				"method": "frappe.ping",
			}
		)
		doc.insert()
		return doc

	def test_get_valid_dict_json_list_requires_v2(self):
		doc = self._make_doc()
		doc.arguments = [{"a": 1}]
		with disable_v2():
			self.assertRaises(frappe.ValidationError, doc.get_valid_dict)
		with enable_v2():
			d = doc.get_valid_dict()
			self.assertEqual(d["arguments"], '[{"a":1}]')
			for value in ('{"a": 1}', "1", 1, True):
				doc.arguments = value
				with self.subTest(value=value), self.assertRaises(frappe.ValidationError):
					doc.get_valid_dict()

	def test_get_valid_dict_typed_empty(self):
		doc = self._make_doc()
		doc.ref_doctype = ""
		doc.arguments = ""
		doc.queue = ""
		with enable_v2():
			d = doc.get_valid_dict()
			self.assertIsNone(d["ref_doctype"])
			self.assertIsNone(d["arguments"])
			self.assertEqual(d["queue"], "")
		with disable_v2():
			d = doc.get_valid_dict()
			self.assertEqual(d["ref_doctype"], "")
			self.assertEqual(d["arguments"], "")
			self.assertEqual(d["queue"], "")

	def test_non_direct_projections_have_no_typed_plan(self):
		with enable_v2():
			queries = (
				frappe.qb.get_query(
					self.TEST_DOCTYPE,
					fields=[{"IFNULL": ["ref_doctype", "''"], "as": "computed"}],
				),
				frappe.qb.get_query(
					self.TEST_DOCTYPE,
					fields=[{"CONCAT": ["ref_doctype", "ref_doctype"], "as": "computed"}],
				),
				frappe.qb.get_query(
					self.TEST_DOCTYPE,
					fields=["user.user_defaults as joined_defaults"],
				),
			)
		for query in queries:
			self.assertIsNone(query.__dict__.get("_typed_plan"))

	def test_load_and_orm_normalization(self):
		doc = self._make_doc()
		table = "`tabBackground Task`"
		# Legacy empty-string artifact on a Link (varchar) column. JSON columns cannot
		# hold "" on schemas with CHECK json_valid constraints, so JSON empty-string
		# normalization is covered by the unit tests instead.
		frappe.db.sql(f"UPDATE {table} SET `ref_doctype` = '' WHERE `name` = %s", doc.name)

		with disable_v2():
			doc.reload()
			self.assertEqual(doc.ref_doctype, "")
			self.assertEqual(frappe.db.get_value(self.TEST_DOCTYPE, doc.name, "ref_doctype"), "")
			legacy_as_list = frappe.get_all(
				self.TEST_DOCTYPE, filters={"name": doc.name}, fields=["ref_doctype"], as_list=True
			)

		with enable_v2():
			doc.reload()
			self.assertIsNone(doc.ref_doctype)
			self.assertIsNone(frappe.db.get_value(self.TEST_DOCTYPE, doc.name, "ref_doctype"))
			as_list = frappe.get_all(
				self.TEST_DOCTYPE, filters={"name": doc.name}, fields=["ref_doctype"], as_list=True
			)
			self.assertIsInstance(as_list[0], type(legacy_as_list[0]))
			self.assertIsNone(as_list[0][0])
			self.assertEqual(
				frappe.get_all(self.TEST_DOCTYPE, filters={"name": doc.name}, pluck="ref_doctype"),
				[None],
			)

		frappe.db.sql(f"UPDATE {table} SET `arguments` = %s WHERE `name` = %s", ('{"x": 1}', doc.name))
		with disable_v2():
			doc.reload()
			self.assertEqual(doc.arguments, '{"x": 1}')
		with enable_v2():
			doc.reload()
			self.assertEqual(doc.arguments, {"x": 1})
			self.assertEqual(frappe.db.get_value(self.TEST_DOCTYPE, doc.name, "arguments"), {"x": 1})
			star = frappe.db.get_value(self.TEST_DOCTYPE, doc.name, "*", as_dict=True)
			self.assertEqual(star["arguments"], {"x": 1})
			# Aliased projections stay low-level by contract.
			row = frappe.get_all(self.TEST_DOCTYPE, filters={"name": doc.name}, fields=["arguments as args"])[
				0
			]
			self.assertEqual(row["args"], '{"x": 1}')

	def test_plan_build_verify_apply_idempotent(self):
		from frappe.database.typed_semantics_migration import apply_plan, build_plan, verify_plan

		plan = build_plan()
		for key in (
			"frappe_version",
			"schema_digest",
			"classification",
			"writable_columns",
			"report_only_fields",
			"unknown_fields",
			"backfill_targets",
			"plan_hash",
		):
			self.assertIn(key, plan)
		self.assertGreater(plan["classification"]["writable"], 0)
		verify_plan(plan)

		# Keep the test transaction isolating the UPDATEs: apply's commit/rollback are
		# no-ops here and the class teardown rolls everything back.
		with (
			patch.object(frappe.db, "commit", lambda: None),
			patch.object(frappe.db, "rollback", lambda: None),
		):
			apply_plan(plan)
			second = apply_plan(plan)
		self.assertTrue(second["updated_rows"])
		self.assertTrue(all(n == 0 for n in second["updated_rows"].values()))


class TestMaskedJsonV2Order(IntegrationTestCase):
	MASKED_DOCTYPE = "Test Masked JSON v2"
	TEST_USER = "test-masked-json-v2@example.com"

	def _create_fixture(self):
		if frappe.db.exists("DocType", self.MASKED_DOCTYPE):
			frappe.delete_doc("DocType", self.MASKED_DOCTYPE, force=True, ignore_permissions=True)
		if frappe.db.exists("User", self.TEST_USER):
			frappe.delete_doc("User", self.TEST_USER, force=True, ignore_permissions=True)
		self.addCleanup(self._delete_fixture)

		frappe.get_doc(
			{
				"doctype": "User",
				"email": self.TEST_USER,
				"first_name": "Masked JSON Test",
				"user_type": "Website User",
			}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{
				"doctype": "DocType",
				"name": self.MASKED_DOCTYPE,
				"module": "Core",
				"custom": 1,
				"fields": [
					{"fieldname": "title", "label": "Title", "fieldtype": "Data"},
					{
						"fieldname": "payload",
						"label": "Payload",
						"fieldtype": "JSON",
						"mask": 1,
						"permlevel": 1,
					},
				],
				"permissions": [{"role": "All", "read": 1}, {"role": "All", "read": 1, "permlevel": 1}],
			}
		).insert(ignore_permissions=True)
		frappe.get_doc({"doctype": self.MASKED_DOCTYPE, "title": "fixture", "payload": {"a": 1}}).insert(
			ignore_permissions=True
		)

	def _delete_fixture(self):
		frappe.set_user("Administrator")
		if frappe.db.exists("DocType", self.MASKED_DOCTYPE):
			frappe.delete_doc("DocType", self.MASKED_DOCTYPE, force=True, ignore_permissions=True)
		if frappe.db.exists("User", self.TEST_USER):
			frappe.delete_doc("User", self.TEST_USER, force=True, ignore_permissions=True)
		frappe.db.commit()

	def _as_object(self, value):
		return json.loads(value) if isinstance(value, str) else value

	def test_masked_json_direct_projection_returns_placeholder(self):
		self._create_fixture()
		with enable_v2(), self.set_user(self.TEST_USER):
			row = frappe.get_list(self.MASKED_DOCTYPE, fields=["payload"])[0]
		self.assertEqual(row.payload, "XXXXXXXX")

	def test_authorized_json_direct_projection_returns_object(self):
		self._create_fixture()
		with enable_v2():
			row = frappe.get_list(self.MASKED_DOCTYPE, fields=["payload"])[0]
		self.assertEqual(row.payload, {"a": 1})

	def test_aliased_json_projection_stays_low_level(self):
		self._create_fixture()
		with enable_v2():
			row = frappe.get_list(self.MASKED_DOCTYPE, fields=["payload as aliased_payload"])[0]
		if frappe.db.db_type == "mariadb":
			self.assertIsInstance(row.aliased_payload, str)
		self.assertEqual(self._as_object(row.aliased_payload), {"a": 1})

	def test_switch_off_keeps_legacy_masked_behavior(self):
		self._create_fixture()
		with disable_v2(), self.set_user(self.TEST_USER):
			row = frappe.get_list(self.MASKED_DOCTYPE, fields=["payload"])[0]
		self.assertEqual(row.payload, "XXXXXXXX")
		with disable_v2():
			row = frappe.get_list(self.MASKED_DOCTYPE, fields=["payload"])[0]
		self.assertEqual(self._as_object(row.payload), {"a": 1})
