# Typed Semantics Inventory

Status: Phase 0 inventory only. This document does not enable typed semantics v2 or change a consumer.

Snapshot:

- Frappe: `34e1a5c670c45a626fe44c98e9fc044618f7a1dd`
- AnyDeals: `e2bc6d5a3897899934ddf000a153d564fd6d9c71`
- Branch in both worktrees: `codex/anydeals-provider-dual-db`

## Scope and method

The inventory was derived from standard DocType metadata, then each fieldname was traced through direct Python and JavaScript readers/writers. Generated type annotations, labels, comments, unrelated fields with the same generic name, and test data were not counted as consumers.

Metadata scan:

```sh
rg -n '"fieldtype"\s*:\s*"JSON"' frappe --glob '*.json'
rg -n '"fieldtype"\s*:\s*"JSON"' anydeals_erp --glob '*.json'
```

Result: 8 Frappe fields and 4 AnyDeals fields. No third-party application is included in this first-party inventory, and no third-party compatibility claim is made.

## Current framework contract

- `frappe/types/DF.py`: `JSON = Text`; `Time = str | datetime.time`. The JSON type does not expose the planned object read contract, and the Time type omits the `datetime.timedelta` value returned by database reads.
- `BaseDocument.get_valid_dict`: rejects a non-table `list` before JSON handling and serializes only a JSON `dict`. Empty Date/Datetime/Time values are normalized to `None` through the existing `datetime_fields` branch.
- MariaDB maps JSON to native `json` and Time to `time(6)`. Its driver returns Time as `datetime.timedelta`.
- PostgreSQL maps JSON to `json` and Time to `time(6)`. Registered OID adapters deliberately return JSON as raw text and Time as `datetime.timedelta`, matching current MariaDB behavior.
- `frappe.utils.data.cast("Time", value)` uses `get_timedelta`; an empty value currently becomes zero duration, not the planned typed-v2 `None`.

Therefore the current common JSON read contract is string-oriented. Storage round-trip evidence alone cannot satisfy the planned `dict | list | None` object contract.

## First-party JSON DocField inventory

Legend:

- **Generic only**: `TestDocType.test_json_field` persists an ad-hoc JSON field but accepts either text or a parsed object; it is not per-field object-semantic coverage.
- **Not covered**: no test proving the direct consumer works when the field is already `dict`, `list`, or `None` was found.
- **None recorded**: no owner/issue/reason/expiry waiver exists; a gap remains a blocker and is not silently waived.

| App | DocType | fieldname | Direct readers/writers | MariaDB / PostgreSQL round-trip | Object-semantic coverage | Migration status | Waiver |
| --- | --- | --- | --- | --- | --- | --- | --- |
| frappe | Customize Form Field | `link_filters` | `CustomizeForm.load_properties`, `update_custom_fields`, and `set_property_setters_for_docfield` copy it between meta, the transient row, Custom Field, and Property Setter; `form_builder/components/Field.vue` and `form_builder/store.js` use `JSON.parse`/`JSON.stringify`. | Generic only; no per-field dual-backend assertion. | Not covered; direct consumers require text. | Not started; convert shared link-filter consumers before typed v2. | None recorded. |
| frappe | Customize Form | `link_filters` | No direct runtime reader/writer found beyond metadata and generated typing; `doctype_properties` does not include it. | Generic only; no per-field dual-backend assertion. | Not covered; no consumer contract to exercise. | Disposition required before typed v2: confirm retention or remove through a separately approved migration. | None recorded. |
| frappe | Custom Field | `link_filters` | `CustomField.on_update` routes it through DocType field validation; Customize Form copies it; the resulting meta field is consumed by Link/Attachment Gallery controls. | Generic only; no per-field dual-backend assertion. | Existing validation tests cover JSON text and malformed filter rows, not native objects. | Not started; shared link-filter string dependency remains. | None recorded. |
| frappe | DocField | `link_filters` | `validate_fields.validate_link_filters` calls `json.loads`; Link and Attachment Gallery controls call `JSON.parse`; list view forwards it to the Link control; Customize Form reads/writes it. | Generic only; no per-field dual-backend assertion. | Text validation is covered in `test_doctype`; native list/dict/`None` behavior is not. | Not started; this is the shared root consumer boundary for the three link-filter storage fields. | None recorded. |
| frappe | Workflow | `workflow_data` | Workflow Builder `store.js` parses only a string, serializes on save, and passes the parsed list to `get_workflow_elements`. | Generic only; no per-field dual-backend assertion. | Not covered; a native list currently falls through to `[]`. | Not started; string-dependent consumer. | None recorded. |
| frappe | Background Task | `arguments` | `retry_task` calls `json.loads(task.arguments)` and spreads the resulting mapping into the queued task. | Generic only; no per-field dual-backend assertion. | Retry tests cover callbacks, not native `dict` arguments. | Not started; string-dependent retry path. | None recorded. |
| frappe | Web Form | `condition_json` | Server list/view path and Web Form client/list code call `json.loads`/`JSON.parse`; form code serializes edited filters. | Generic only; no per-field dual-backend assertion. | Not covered; direct consumers require text. | Not started; shared Web Form filter consumers must accept object values. | None recorded. |
| frappe | Web Form | `dynamic_filters_json` | `frappe/www/list.py` calls `json.loads`; Web Form form code and dashboard utilities call `JSON.parse` and serialize edited filters. | Generic only; no per-field dual-backend assertion. | Not covered; direct consumers require text. | Not started; shared Web Form dynamic-filter consumers must accept object values. | None recorded. |
| anydeals_erp | Process Period Closing Voucher Detail | `closing_balance` | `process_individual_date` serializes query rows; `get_consolidated_gles` calls `frappe.json.loads` on every row. | Field-specific test exercises persistence on its selected database; no dual-backend result is established by this inventory task. | Existing test reparses the database value with `frappe.parse_json`; it does not exercise an already-native list in the consumer. | Not started; string-dependent consolidation path. | None recorded. |
| anydeals_erp | Process Period Closing Voucher | `p_l_closing_balance` | `get_gl_entries` serializes and writes the dimension balance; no direct reader found. | No per-field dual-backend assertion found. | Not covered; no direct reader contract found. | Writer-only field in current code; retain serialized writes until a reader/lifecycle decision is tested. | None recorded. |
| anydeals_erp | Process Period Closing Voucher | `bs_closing_balance` | `calculate_balance_sheet_balance` serializes and writes the dimension balance; no direct reader found. | No per-field dual-backend assertion found. | Not covered; no direct reader contract found. | Writer-only field in current code; retain serialized writes until a reader/lifecycle decision is tested. | None recorded. |
| anydeals_erp | Bank Statement Import Log | `pdf_tables` | `get_pdf_tables` accepts text or an already-native object; preparation, attachment update, and `apply_pdf_tables` serialize writes; statement detail APIs consume the normalized list. | End-to-end tests exercise persistence on their selected database; no dual-backend result is established by this inventory task. | Partial: the reader has an object branch and end-to-end list assertions, but no test explicitly assigns a native JSON field value before calling the consumer. | Closest to object-ready; explicit native-value coverage and non-serialized writes remain for typed v2. | None recorded. |

## Time and typed-empty inventory

Metadata contains 1 standard Frappe Time field (`Event Notifications.time`, nullable) and 46 standard AnyDeals Time fields, of which 23 are nullable. This is a schema count, not a claim that each consumer has typed-v2 coverage.

Current evidence:

- `frappe.tests.test_utils.TestFieldCasting.test_time_types` asserts that `cast("Time", None)` and a time string return `datetime.timedelta`; it preserves current zero-duration-on-empty behavior.
- Database tests cover Time value persistence, and PostgreSQL-specific tests cover bulk-insert parity, including values above 24 hours. They do not establish the planned nullable typed-empty contract.
- No per-field consumer inventory for all 47 Time fields is required by this Phase 0 JSON consumer gate. D3-02A must use metadata to enumerate nullable typed columns before its dry-run/backfill work.

## Waiver and release gate

Open formal waivers: **0**.

The uncovered rows above are migration blockers, not waivers. A future waiver is valid only with owner, issue, reason, and expiry. Typed semantics v2 must remain opt-in and cannot reach the v18 RC gate until every first-party JSON direct consumer has object-semantic coverage, both database round-trips are proven, and the waiver count remains zero.

## Unknowns

- Live PostgreSQL results for the 12 first-party fields are Unknown in this task: the local Bench exposes no PostgreSQL site, and configured CI is not evidence of a completed run.
- The hidden `Customize Form.link_filters` field has no direct runtime consumer in the scanned repository. Its retention/removal intent is Unknown; typed-v2 work must resolve that disposition without inventing behavior.
