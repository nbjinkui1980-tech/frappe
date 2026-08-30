"""Typed semantics v2 site switch.

`typed_semantics_v2` is a site-level opt-in stored in `site_config.json`. It must be
readable before the database connection exists (the postgres adapter decides JSON
decoding registration per connection from it), so it cannot live on a database
Single; `maintenance_mode` is the precedent. Missing key or any falsy value means
the switch is off.

Reads go through `frappe.get_site_config(cached=True)` so all existing invalidation
paths keep working: `bench set-config` -> `update_site_config()` ->
`clear_site_config_cache()`, `frappe.clear_cache()` -> `_SITE_CACHE.clear()`, and
`SiteMigration.setUp()` -> `frappe.clear_cache()`.
"""

import json

import frappe

SWITCH_NAME = "typed_semantics_v2"

# Fieldtypes whose empty string is a legacy MariaDB artifact rather than a real value.
TYPED_EMPTY_FIELDTYPES = frozenset({"Date", "Datetime", "Time", "Link", "JSON"})


def typed_semantics_v2_enabled() -> bool:
	"""Return True only when the current site explicitly opted into typed semantics v2.

	Defaults to off when there is no site context yet (e.g. pre-init bench commands or
	root connections) so early boot paths never change behaviour.
	"""
	try:
		return bool(frappe.get_site_config(cached=True).get(SWITCH_NAME))
	except Exception:
		# No site/config context: the switch defaults to off.
		return False


def normalize_docfield_value(fieldtype: str, value):
	"""Canonical v2 read value for one DocField-typed column.

	Typed-empty ("" -> None) applies to nullable typed columns; JSON text is parsed to
	dict/list (unparseable dirty rows are returned untouched -- the migration gate owns
	cleanup); Time text (sqlite backend) is converted to timedelta.
	"""
	if value == "" and fieldtype in TYPED_EMPTY_FIELDTYPES:
		return None
	if fieldtype == "JSON":
		if isinstance(value, str):
			value = json.loads(value)
		if value is not None and not isinstance(value, dict | list):
			raise ValueError("typed semantics v2 JSON values must be dict, list, or None")
		return value
	if fieldtype == "Time" and isinstance(value, str):
		from frappe.utils.data import get_timedelta

		return get_timedelta(value)
	return value


def normalize_typed_row(row: dict, meta) -> None:
	"""In-place v2 normalization of a DB-loaded row (as_dict) against doctype meta."""
	for fieldname, value in row.items():
		df = meta.get_field(fieldname)
		if df is not None:
			row[fieldname] = normalize_docfield_value(df.fieldtype, value)
