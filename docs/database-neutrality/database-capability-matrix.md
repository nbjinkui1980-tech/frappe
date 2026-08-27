# Database capability matrix

Status: **planned API / current adapter evidence only** (P0-05, 2026-08-28).

This matrix describes Frappe-observable capabilities, not every theoretical database feature.
Configured CI is not proof of a completed run; runtime results not captured in this worktree remain
`Unknown`.

## Planned public API

```python
class DatabaseCapability(StrEnum):
	SESSION_ADVISORY_LOCK = ...
	TRANSACTION_ADVISORY_LOCK = ...
	PARTIAL_INDEX = ...
	COVERING_INDEX = ...
	TRIGRAM_INDEX = ...

Database.capabilities: frozenset[DatabaseCapability]
Database.supports(capability: DatabaseCapability) -> bool
```

Non-enum arguments raise `TypeError`; required unsupported operations raise
`UnsupportedDatabaseCapabilityError`. New business code queries capability and either degrades
explicitly or fails. It must not add `db_type == ...` branches.

## Matrix

| Capability | MariaDB 11.8 adapter evidence | PostgreSQL 18 adapter evidence | Planned public contract | Live verification |
| --- | --- | --- | --- | --- |
| Session advisory lock | `advisory_lock` uses `GET_LOCK`/`RELEASE_LOCK`. | `advisory_lock` uses PostgreSQL session advisory locks. | Supported by both. | `Unknown` for this task. |
| Transaction advisory lock | Base implementation rejects it; MariaDB has no override. | PostgreSQL override uses transaction-scoped advisory locks. | PostgreSQL only; explicit unsupported error elsewhere. | `Unknown` for this task. |
| Partial index | MariaDB `add_index(where=...)` falls back to a plain index. | PostgreSQL `add_index(where=...)` emits a partial index. | PostgreSQL only; caller must choose explicit fallback/failure. | `Unknown` for this task. |
| Covering index | MariaDB `add_index(include=...)` falls back to a plain index. | PostgreSQL `add_index(include=...)` emits `INCLUDE`. | PostgreSQL only; caller must choose explicit fallback/failure. | `Unknown` for this task. |
| Trigram index | MariaDB rejects/skips PostgreSQL-specific `using` modes. | PostgreSQL `gin_trgm` creates/uses `pg_trgm`. | PostgreSQL only; caller must choose explicit fallback/failure. | `Unknown` for this task. |

The enum, `capabilities`, `supports`, and `UnsupportedDatabaseCapabilityError` are **not
implemented**. Existing adapter methods do not by themselves satisfy the planned API contract.

## Explicit non-capabilities and boundaries

- `TRANSACTIONAL_DDL` is deliberately absent. Current `Database.sql_ddl()` commits before DDL on
  every backend, and no transactional-DDL API is planned.
- Existing `DBTable`, `add_index`, `sql_ddl`, and schema adapters remain the DDL implementation
  boundary; no parallel schema DSL is introduced.
- Authorized DocType, Customize Form, Custom Field, install, migrate, and maintenance DDL continues
  through existing schema adapters.
- New/modified request or job code outside authorized boundaries is planned to fail the per-repo
  stdlib DDL checker. The checker does not claim to ban all raw SQL.
- Query changes using retained parameterized raw SQL require MariaDB and PostgreSQL behavior tests.

## CI evidence boundary

Current workflow configuration can select MariaDB 11.8 and PostgreSQL 18. Frappe PR PostgreSQL
selection depends on the current roulette output/label path; AnyDeals PR PostgreSQL execution is
label-gated, while scheduled and manually dispatched workflows are configured. No completed
Database Contract, full, RC, or required-check repository-setting evidence was produced by P0-05;
all such results are `Unknown`.
