# Provider and application alias ADR

Status: **planned / not implemented** (P0-05, 2026-08-28).

## Context

Frappe currently contains AnyDeals-specific identity handling. The current setup path marks an
application complete after each task, derives overall completion from `Installed Application`, and
has no Provider descriptor, database binding, `FRESH/BOUND/BROKEN` state, or atomic finalizer. Queue
writes and Patch Log entries also preserve legacy names. These are baseline facts, not the target
contract.

The target keeps Frappe brand-neutral and limits compatibility to entry points. Internal state, new
jobs, new Patch Log rows, and external output use the canonical application name.

## Decision

An application may declare this strict raw `hooks.py` attribute:

```python
frappe_app_provider = {
	"schema_version": 1,
	"kind": "erp",
	"canonical_app": "anydeals_erp",
	"legacy_aliases": [{"name": "erpnext", "remove_in": "v19"}],
}
```

Frappe will expose four brand-neutral interfaces:

```python
load_app_provider_descriptor(app_name)
get_capability_provider(kind)
resolve_app_name(name)
resolve_dotted_path(path, *, surface)
```

The loader imports `<app>.hooks` directly. Unknown versions or fields, duplicate providers, alias
cycles, conflicts with real applications, invalid dotted paths, and missing targets fail closed.
Only a complete first dotted-path segment is replaceable; URLs, email addresses, ordinary text, and
names such as `myerpnext.*` are unchanged. Descriptor and resolution results use the existing site
cache and existing cache-clear/migrate invalidation paths. Descriptor v1 has no setup probe.

## Binding state machine

The only binding authority is the database `DefaultValue` global key:

```json
{"active_app_providers": {"erp": "anydeals_erp"}}
```

`site_config.json` neither stores nor decides the binding.

| State | Planned meaning | Allowed transition |
| --- | --- | --- |
| `FRESH` | Canonical Provider is incomplete and no database binding exists. | The unique candidate may run setup. |
| `BOUND` | Provider completion, canonical binding, and derived setup completion agree. | Normal startup after installed/active/descriptor checks. |
| `BROKEN` | Completion, binding, installation, activation, or descriptor is missing or inconsistent. | Normal startup stops; only migrate bootstrap may repair after dry-run. |

Provider tasks, including `setup_wizard_complete`, do not call per-task completion. The Provider
finalizer is not a stage or task; it runs exactly once in the successful tail of
`process_setup_stages()`:

```text
run_setup_success
→ Provider finalizer
→ precise is_setup_complete request-cache invalidation
→ true re-read and assertion
→ best-effort completed telemetry
→ telemetry preference
→ success response/publication
```

The finalizer does not commit. In the current transaction it writes, in order:

1. canonical Provider `Installed Application.is_setup_complete = 1`;
2. `DefaultValue.active_app_providers` canonical binding;
3. `System Settings.setup_complete = 1`.

Any success-tail exception uses the existing setup failure handler and rolls back the current
transaction. This guarantee covers only those three finalizer writes. Earlier language or regional
DDL commits are not rolled back; reachable Company, Fiscal Year, Price List, Custom Field,
bank/default, and demo authority state must therefore replay deterministically and fail closed on
conflict. No checkpoint ledger is introduced.

## Runtime and retirement

`get_attr`, API dispatch, queue write/read, synchronous `now=True`, and Patch Log use one exact
resolver. New persisted references are canonical; old queue payloads remain readable. Callable jobs
must be re-resolvable by canonical module and qualname before enqueue.

The AnyDeals-only exact import Finder and alias remain for v17/v18. Legacy Patch Log rows remain
read-only and gain canonical markers rather than being rewritten. Finder removal in v19 requires
clean canonical source/persisted scans, two formal releases with zero calls on reliable site
surfaces, and compatibility tests. Missing or unowned import telemetry is `Unknown`, never zero.
Compatibility telemetry remains through v20.

## Activation and rollback

Strict enforcement, identity cleanup, and binding activation form one coordinated two-repository
maintenance bundle: stop services, back up, record both old refs, update both checkouts, run raw
descriptor/database bootstrap preflight and dry-run, apply the binding transaction, migrate and
audit, then restart only after all checks pass. Before binding apply, rollback restores both refs;
after apply, rollback restores the full backup and both refs. Services remain stopped until recovery
finishes. This ADR does not authorize production activation.

## Current evidence and unknowns

- Current behavior is recorded in `frappe/desk/page/setup_wizard/current_behavior_inventory.md` and
  the AnyDeals companion inventory.
- Provider interfaces, descriptor validation, state machine, finalizer, canonical queue/Patch Log
  writes, bootstrap, and coordinated activation are **not implemented**.
- Replay safety after regional DDL and late success-tail failures is `Unknown`.
- Production bundle execution, rollback rehearsal, and v19/v20 retirement evidence are `Unknown`.
