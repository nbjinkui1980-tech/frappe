"""Scanner and backfill logic for the `typed-semantics-v2` migration command.

The CLI in `frappe/commands/typed_semantics.py` is a thin wrapper over this module.

Classification:
- writable: typed columns of doctypes owned by first-party apps (frappe, anydeals_erp);
  only these tables are ever written.
- report_only: typed columns of custom doctypes (`DocType.custom = 1`, reason
  `custom_doctype` — custom takes precedence over app attribution), of third-party
  app doctypes, and the explicitly parked `Customize Form.link_filters`; never
  modified.
- unknown: fields that metadata cannot attribute or whose column is missing from the
  schema; apply refuses to run while any unknown exists.

Backend capability notes (why counts are not uniform):
- `Link` columns are varchar on both backends and can hold ""; counted everywhere.
- `JSON` is longtext on MariaDB (can hold "" and invalid JSON) but jsonb on postgres
  (neither "" nor invalid JSON is storable, and `col = ''` would raise), so JSON row
  scans run on MariaDB only.
- Date/Datetime/Time columns are native types on both backends and cannot hold "";
  their candidate count is zero by construction.
- NOT NULL numeric columns never need backfill (nothing to convert) and comparing
  them to '' would coerce on MariaDB / raise on postgres, so they are classification-
  only.
"""

import hashlib
import json

import frappe
from frappe.utils import get_table_name
from frappe.utils.data import now_datetime

FIRST_PARTY_APPS = ("frappe", "anydeals_erp")
NULLABLE_TYPED_FIELDTYPES = frozenset({"JSON", "Date", "Datetime", "Time", "Link"})
NOT_NULL_NUMERIC_FIELDTYPES = frozenset({"Check", "Int", "Currency", "Float", "Percent"})

# Hidden field parked by the locked contract: reported, never migrated.
REPORT_ONLY_FIELDS = frozenset({("Customize Form", "link_filters")})


def _canonical_hash(obj) -> str:
	payload = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
	return hashlib.sha256(payload.encode()).hexdigest()


def _information_schema_columns() -> dict[tuple[str, str], bool]:
	"""Map (table, column) -> nullable for every column in the current site schema."""
	if frappe.db.db_type == "postgres":
		schema = frappe.conf.get("db_schema") or "public"
	else:
		schema = frappe.conf.db_name
	rows = frappe.db.sql(
		"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = %s",
		(schema,),
		as_dict=True,
	)
	return {(r.table_name, r.column_name): r.is_nullable == "YES" for r in rows}


def _classify_fields() -> tuple[list, list, list]:
	"""Classify all typed DocField columns into (writable, report_only, unknown)."""
	columns = _information_schema_columns()
	writable, report_only, unknown = [], [], []
	writable_keys = set()

	doctypes = frappe.get_all(
		"DocType",
		filters={"issingle": 0, "is_virtual": 0},
		fields=["name", "module", "custom"],
	)
	for doctype_row in doctypes:
		doctype = doctype_row.name
		try:
			app = frappe.get_doctype_app(doctype)
		except KeyError:
			app = None

		meta = frappe.get_meta(doctype)
		table = get_table_name(doctype)
		for df in meta.get("fields"):
			if df.fieldtype not in NULLABLE_TYPED_FIELDTYPES | NOT_NULL_NUMERIC_FIELDTYPES:
				continue
			if getattr(df, "is_virtual", 0):
				continue
			entry = {
				"doctype": doctype,
				"table": table,
				"column": df.fieldname,
				"fieldtype": df.fieldtype,
			}
			if doctype_row.custom:
				report_only.append(entry | {"app": app, "reason": "custom_doctype"})
				continue
			if (doctype, df.fieldname) in REPORT_ONLY_FIELDS:
				report_only.append(entry | {"app": app, "reason": "parked_by_contract"})
				continue
			if app is None:
				unknown.append(entry | {"reason": "module_not_attributed"})
				continue
			if app not in FIRST_PARTY_APPS:
				report_only.append(entry | {"app": app})
				continue
			key = (table, df.fieldname)
			if key not in columns:
				unknown.append(entry | {"reason": "column_missing"})
				continue
			if key in writable_keys:
				continue
			writable_keys.add(key)
			writable.append(entry | {"nullable": columns[key]})

	# Singles do not have a physical DocType table and are excluded above. Keep the
	# explicitly parked field visible in the report without making it writable.
	for doctype, fieldname in REPORT_ONLY_FIELDS:
		if any(e["doctype"] == doctype and e["column"] == fieldname for e in report_only):
			continue
		df = frappe.get_meta(doctype).get_field(fieldname)
		if df:
			report_only.append(
				{
					"doctype": doctype,
					"table": get_table_name(doctype),
					"column": fieldname,
					"fieldtype": df.fieldtype,
					"app": frappe.get_doctype_app(doctype),
					"reason": "parked_by_contract",
				}
			)

	return writable, report_only, unknown


def _schema_digest(writable, report_only, unknown) -> str:
	surface = (
		[(e["table"], e["column"], e["fieldtype"], e.get("nullable"), "writable") for e in writable]
		+ [(e["table"], e["column"], e["fieldtype"], None, "report_only") for e in report_only]
		+ [(e["table"], e["column"], e["fieldtype"], None, "unknown") for e in unknown]
	)
	return _canonical_hash(sorted(surface))


def _count_empty_strings(table: str, column: str) -> int:
	return frappe.db.sql(f"SELECT COUNT(*) FROM `{table}` WHERE `{column}` = ''")[0][0]


def _empty_string_source_digest(table: str, column: str) -> str:
	rows = frappe.db.sql(f"SELECT `name` FROM `{table}` WHERE `{column}` = '' ORDER BY `name`")
	return _canonical_hash([row[0] for row in rows])


def _find_invalid_json_rows(doctype: str, table: str, column: str) -> list[dict]:
	rows = frappe.db.sql(
		f"SELECT `name`, `{column}` FROM `{table}` WHERE `{column}` IS NOT NULL ORDER BY `name`",
		as_dict=True,
	)
	invalid = []
	for row in rows:
		value = row[column]
		if value == "":
			continue
		try:
			if isinstance(value, str):
				value = json.loads(value)
		except (TypeError, ValueError):
			invalid.append({"doctype": doctype, "name": row.name, "fieldname": column})
			continue
		if value is not None and not isinstance(value, dict | list):
			invalid.append({"doctype": doctype, "name": row.name, "fieldname": column})
	return invalid


def _is_backfillable(entry: dict) -> bool:
	"""Columns that can physically hold "" and therefore need/allow the NULL backfill."""
	return entry["nullable"] and (
		entry["fieldtype"] == "Link" or (entry["fieldtype"] == "JSON" and frappe.db.db_type == "mariadb")
	)


def _scan_writable_column(entry: dict) -> dict:
	"""Attach row-level candidate counts to one writable column entry."""
	empty_rows = 0
	empty_source_digest = _canonical_hash([])
	invalid_locations: list[dict] = []

	if _is_backfillable(entry):
		empty_rows = _count_empty_strings(entry["table"], entry["column"])
		empty_source_digest = _empty_string_source_digest(entry["table"], entry["column"])
	if entry["fieldtype"] == "JSON":
		invalid_locations = _find_invalid_json_rows(entry["doctype"], entry["table"], entry["column"])

	return entry | {
		"empty_string_rows": empty_rows,
		"empty_string_source_digest": empty_source_digest,
		"invalid_json_rows": len(invalid_locations),
		"invalid_json_locations": invalid_locations,
	}


def build_plan() -> dict:
	"""Read-only scan of the current site; returns the full plan/report structure."""
	writable, report_only, unknown = _classify_fields()
	scanned = [_scan_writable_column(e) for e in writable]

	backfill_targets = [{"table": e["table"], "column": e["column"]} for e in scanned if _is_backfillable(e)]

	plan = {
		"frappe_version": frappe.__version__,
		"generated_at": now_datetime().isoformat(),
		"db_type": frappe.db.db_type,
		"schema_digest": _schema_digest(writable, report_only, unknown),
		"classification": {
			"writable": len(scanned),
			"report_only": len(report_only),
			"unknown": len(unknown),
		},
		"writable_columns": scanned,
		"report_only_fields": report_only,
		"unknown_fields": unknown,
		"backfill_targets": backfill_targets,
	}
	plan["plan_hash"] = _canonical_hash(plan)
	return plan


def _execution_surface(plan: dict) -> dict:
	"""Plan fields that authorize writes and summarize their current source rows."""
	return {
		key: plan.get(key)
		for key in (
			"frappe_version",
			"db_type",
			"schema_digest",
			"classification",
			"writable_columns",
			"report_only_fields",
			"unknown_fields",
			"backfill_targets",
		)
	}


def _applied_execution_surface(plan: dict) -> dict:
	"""Expected execution surface when every authorized target is already satisfied."""
	surface = _execution_surface(plan)
	targets = {(target["table"], target["column"]) for target in plan.get("backfill_targets", [])}
	surface["writable_columns"] = [
		entry
		| {
			"empty_string_rows": 0,
			"empty_string_source_digest": _canonical_hash([]),
		}
		if (entry.get("table"), entry.get("column")) in targets
		else entry
		for entry in plan.get("writable_columns", [])
	]
	return surface


def _validate_scan(plan: dict, *, source: str) -> None:
	if plan.get("classification", {}).get("unknown"):
		raise ValueError(f"{source} contains unknown-classified fields; resolve them before applying")
	if sum(c.get("invalid_json_rows", 0) for c in plan.get("writable_columns", [])):
		raise ValueError(f"{source} contains invalid JSON rows; fix them before applying")


def verify_plan(plan: dict) -> None:
	"""Fail-closed plan validation; raises ValueError on any inconsistency."""
	plan_hash = plan.get("plan_hash")
	if not plan_hash:
		raise ValueError("plan is missing plan_hash")
	if _canonical_hash({k: v for k, v in plan.items() if k != "plan_hash"}) != plan_hash:
		raise ValueError("plan_hash mismatch: plan file was modified after generation")

	_validate_scan(plan, source="plan")
	current = build_plan()
	_validate_scan(current, source="current database")
	current_surface = _execution_surface(current)
	if current_surface not in (_execution_surface(plan), _applied_execution_surface(plan)):
		raise ValueError("plan source mismatch: schema or source rows changed since the dry-run")


def apply_plan(plan: dict) -> dict:
	"""Backfill `"" -> NULL` for the plan's writable columns in a single transaction.

	Re-audits candidate counts inside the transaction and rolls back on any residue,
	so a failed apply leaves no partial state. Re-applying a satisfied plan updates
	zero rows.
	"""
	updated = {}
	try:
		verify_plan(plan)
		for target in plan["backfill_targets"]:
			frappe.db.sql(
				f"UPDATE `{target['table']}` SET `{target['column']}` = NULL WHERE `{target['column']}` = ''"
			)
			updated[f"{target['table']}.{target['column']}"] = frappe.db._cursor.rowcount

		residue = {}
		for entry in plan["writable_columns"]:
			if _is_backfillable(entry):
				remaining = _count_empty_strings(entry["table"], entry["column"])
				if remaining:
					residue[f"{entry['table']}.{entry['column']}"] = remaining
		if residue:
			raise ValueError(f"audit rescan found remaining empty-string rows: {residue}")

		frappe.db.commit()
	except Exception:
		frappe.db.rollback()
		raise

	return {"updated_rows": updated, "columns_written": len(plan["backfill_targets"])}
