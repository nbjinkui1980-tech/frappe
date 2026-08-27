# Setup and identity current-behavior inventory

This is the P0-01 baseline for the two `codex/anydeals-provider-dual-db` worktrees. It records current reachable behavior only; it does not define the future Provider contract.

## Reachable setup chain

| Entry or phase | Current reachable behavior | Authority/write boundary | Transaction boundary |
| --- | --- | --- | --- |
| `setup_complete` | Takes the `setup_wizard` file lock, returns early when `frappe.is_setup_complete()` is true, sanitizes/parses input, then calls `get_setup_stages` and `process_setup_stages`. A lock timeout is reported as success without a second completion read. | Reads current completion through `frappe.is_setup_complete`. | No explicit commit here; the request transaction owns final success commit/exception rollback. |
| `complete_app_setup` | Requires System Manager, rejects sites with stage/complete hooks, takes the same lock, and runs the same engine without app input stages. A lock timeout returns success only after a true completion read. | Same completion read. | Same request transaction boundary. |
| `get_setup_stages` | Orders `update_global_settings`, active-app `setup_wizard_stages`, merged `setup_wizard_complete`, then `run_post_setup_complete`. AnyDeals contributes the canonical stage hook documented in its companion inventory. | `update_app_details_in_stages` attributes hook tasks without `app_name` to the owning app; complete-hook ownership is the dotted path's first segment. | Construction only. |
| `process_setup_stages` task loop | Takes one snapshot of completed wizard apps, skips tasks owned by apps in that snapshot, executes every other task, then calls `enable_setup_wizard_complete` after every task. Tasks without an owner mark `frappe`. The snapshot is not refreshed, so all tasks from an initially incomplete app still run while its completion row is repeatedly set. | `Installed Application.is_setup_complete = 1` is written per task. | Stage exceptions call `handle_setup_exception`, which performs a full rollback and invokes exception hooks. |
| Current success tail | After the guarded task loop: `run_setup_success` → `completed_server_side` telemetry → `apply_telemetry_preference` → HTTP return or background realtime success. `run_setup_success` runs merged success hooks, Frappe fixture install, and optional login. | `System Settings.enable_telemetry` is written after completed telemetry. Telemetry is not authority state. | This code is in the `else` of the task `try`; success-tail exceptions do not enter the stage exception handler. |
| `run_post_setup_complete` wrapping task | Calls `disable_future_access`, commits, clears caches, and refreshes System Settings. `disable_future_access` writes the default home page, onboarding, and `System Settings.setup_complete = frappe.is_setup_complete()`. | System Settings completion is derived from Installed Application completion. | Explicit `frappe.db.commit()` before the later success tail. |
| Background execution | Setup can be enqueued through the existing queue path. `enqueue` currently persists the supplied method object/string unchanged; `execute_job` resolves a string with `frappe.get_attr`, commits on success, and rolls back on failure before logging. | No separate setup authority. | `execute_job` is the final background commit/rollback owner. |

`update_global_settings` also commits immediately when it changes the default language. The app inventory records reachable regional Custom Field DDL; `create_custom_fields → frappe.db.updatedb → schema sync/sql_ddl` commits before the wrapping task. Therefore current setup is not one transaction, and a later rollback cannot undo those earlier commit boundaries.

## Current authority state

- `frappe.is_setup_complete` is request-cached and derives completion from truthy `Installed Application.is_setup_complete` rows for `frappe` plus the ERP app. It chooses `anydeals_erp` when installed, otherwise `erpnext`, and excludes disabled apps.
- `InstalledApplications.update_versions` uses the same brand choice. It infers Frappe completion from a non-admin System User and ERP completion from any Company, then writes the derived result to `System Settings.setup_complete`.
- There is no Provider descriptor, `active_app_providers` binding, `FRESH/BOUND/BROKEN` state, or atomic three-write finalizer in the current code.
- `System Settings.setup_complete` and telemetry are derived signals, not the current predicate used by `frappe.is_setup_complete`.

## Current identity and compatibility entries

| Surface | Current behavior |
| --- | --- |
| Dotted method | `frappe.utils.get_attr` rewrites only a leading `erpnext` app segment to `anydeals_erp` when the latter is installed, then performs the installed-app check and import. |
| Queue write/read | Queue writes preserve the supplied method and callback values. Worker reads pass string methods through `frappe.get_attr`, so legacy strings resolve through the rule above. |
| Patch Log | `patch_handler` compares and records patch strings literally. Legacy and canonical dotted paths are distinct entries. Patch execution explicitly commits before and after each patch and rolls back the patch transaction on failure. |
| Legacy Gravatar | `get_gravatar_image_fields` adds `Lead.image` when either `anydeals_erp` or `erpnext` is installed. |
| Python/assets | The exact import Finder and asset symlink behavior live in the AnyDeals companion inventory. |

## Deliberate exclusions

- `anydeals_erp.setup.setup_wizard.setup_wizard.setup_complete` has no hook or repository caller in the current worktrees; it is not part of this reachable setup chain.
- `operations/company_setup.py` and `operations/defaults_setup.py` have no repository caller in the current worktrees; the active stages delegate to `operations/install_fixtures.py`.
- No test result in this file implies Provider, replay-idempotency, dual-database parity, release, or migration readiness.
