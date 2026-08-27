# Database-neutral v2 guide

Status: **planned / not implemented** (P0-05, 2026-08-28).

## Contract

Neutral v2 defines application-visible types, transactions, DDL boundaries, and capability checks
equally for MariaDB 11.8 and PostgreSQL 18. Database-specific implicit conversion is not an
application contract. Unknown capabilities, migration differences, invalid JSON, and unsupported
required operations fail closed.

This guide does not authorize production database switching.

## MariaDB-golden historical boundary

The current release and rollback documentation treats MariaDB as the production target and has no
PostgreSQL recovery path. That is the historical MariaDB-golden contract. It remains the authority
until neutral-v2 contract tests, dual-database CI, encrypted migration rehearsal, restore audit, and
release gates have real passing evidence.

Neutral v2 does not reinterpret existing MariaDB-only runs as dual-database proof. PostgreSQL
workflow configuration, a green subset, or successful storage round-trip alone is insufficient.

## Planned adoption sequence

1. Keep the Phase 0 JSON/Time inventory and current CI truth table current.
2. Add the public capability API and preserve existing schema adapters.
3. Implement typed-v2 scanner, consumer changes, transactional backfill, and the single site switch.
4. Add both-repository DDL boundary checks without a broad raw-SQL ban.
5. Prove non-empty Database Contract suites on both databases for every PR.
6. Prove AnyDeals domain invariants, full PostgreSQL classification, and RC orchestration.
7. Rehearse encrypted MariaDB-to-disposable-PostgreSQL exact-load, audit, and restore.
8. Enable the performance/release gate only after a fixed-runner baseline is stable.

Typed v2 remains independent of initial Provider delivery and PostgreSQL parity. It is opt-in in
v17, may become default-with-opt-out in v18 only after its first-party gate, and removes legacy mode
in v19.

## Application rules

- JSON reads are `dict | list | None`; Time reads are `datetime.timedelta | None`.
- Data/Text preserves `""`; nullable Date/Datetime/Time/Link/JSON maps `""` to `None`.
- Required invalid values are rejected at the DocType boundary.
- Only Document/ORM/direct DocField projections normalize values. Expressions, aliases, bare tables,
  and `frappe.db.sql()` remain low-level.
- New business code asks `Database.supports(...)`; it does not branch on database type.
- Unsupported required capabilities stop with the planned typed exception.
- Request/job success commits and exceptions roll back; continuing after a caught database error
  uses an existing savepoint.
- Authorized DDL uses existing `updatedb`, schema adapter, and maintenance paths.
- Raw SQL policy is limited to the actual DDL and PostgreSQL-compatibility checkers; no universal raw
  SQL ban is claimed.

## Evidence required before changing status

| Gate | Required evidence | P0-05 status |
| --- | --- | --- |
| Typed v2 | Complete first-party inventory, consumer object tests, both-database round-trip, zero waivers, audited backfill. | `Unknown`; not implemented. |
| Capability API | Enum/type validation, backend sets, supported and unsupported behavior tests. | `Unknown`; not implemented. |
| DDL boundary | Both repository checkers, fixtures, changed-file non-empty selection, CI result. | `Unknown`; future task. |
| Database Contract | Explicit non-empty suites on MariaDB and PostgreSQL for both repositories. | `Unknown`; future task. |
| PostgreSQL full/RC | Real workflow run IDs and whole-workflow success; Frappe `Server Success` where required. | `Unknown`; future task. |
| Required checks | Repository-settings evidence. | `Unknown`; external setting. |
| Encrypted rehearsal | Marker validation, AEAD/checksum, exact load, auth/attachment/business audit, cleanup/restore report. | `Unknown`; future task. |
| Performance | Same runner/data/base/head, 5 warmups, 20 samples, CV at most 10%, median regression at most 15%. | `Unknown`; pyperf baseline blocked. |

## Current stop condition

Only the inventories and current workflow/configuration evidence exist. Neutral-v2 code, activation,
dual-database completion, encrypted rehearsal, release approval, and database cutover are **not
implemented or not run**. MariaDB therefore remains the historical operational authority.
