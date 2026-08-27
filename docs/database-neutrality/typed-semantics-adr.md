# Typed semantics v2 ADR

Status: **planned / not implemented** (P0-05, 2026-08-28).

## Context

Current first-party JSON reads are string-oriented. The Phase 0 inventory identifies 12 JSON
DocFields with missing or partial object-semantic consumer coverage. Current `cast("Time", empty)`
returns zero duration, while the planned nullable typed contract requires `None`. Live PostgreSQL
results for the inventory are `Unknown`.

Typed semantics v2 is a server-side public model contract. It is not a PostgreSQL adapter-only fix,
does not block initial Provider or PostgreSQL-parity delivery, and cannot become default before its
own first-party application gate passes.

## Decision

One site switch controls JSON object semantics and typed-empty migration.

| Release | Planned lifecycle |
| --- | --- |
| v17 | Opt-in only. |
| v18 | Default on, with temporary opt-out, only after the release gate passes. |
| v19 | Remove legacy mode and the switch. |

Canonical values are:

| Field family | Canonical value |
| --- | --- |
| JSON | `dict | list | None` |
| Time reads | `datetime.timedelta | None` |
| Data/Text | Preserve `""`. |
| Nullable Date/Datetime/Time/Link/JSON | Normalize `""` to `None`. |
| NOT NULL Check/Int/Currency/Float/Percent | Normalize empty to `0`. |
| Required invalid input | Reject at the DocType boundary. |

Normalization applies only to ORM, Document, and projections that identify a direct DocField.
Expressions, aliases, bare tables, and `frappe.db.sql()` retain low-level behavior.

`DF.Time` permanently keeps the assignment surface:

```python
Time = str | datetime.time | datetime.timedelta
```

Database/ORM reload, identifiable direct Time projections, and `cast("Time")` have the narrower
canonical read result `datetime.timedelta | None`. The assignment union is not narrowed in v19.

## Enablement gate

Before a site enables v2:

1. inventory every first-party JSON DocField and its direct readers/writers;
2. remove `json.loads`, string comparison/concatenation, and serialization assumptions at each
   direct consumer;
3. prove object semantics per consumer and round-trip on MariaDB and PostgreSQL;
4. keep every temporary waiver complete with owner, issue, reason, and expiry;
5. update public `DF.JSON` and `BaseDocument` assignment/read contracts;
6. scan nullable typed columns from metadata, report `"" → NULL` counts, and reject invalid JSON;
7. run transactional backfill in maintenance mode, audit it, then enable the switch.

Third-party applications receive scanner/report output only. This work does not modify them or claim
compatibility. v18 RC requires zero open and zero unexpired waivers.

## Consequences

- Consumers receive stable application-level types on both supported databases.
- Existing low-level SQL behavior remains available and explicit.
- Migration cannot be inferred from schema round-trip alone; direct consumer behavior is mandatory.
- Provider and database parity may ship while typed v2 remains disabled.

## Current evidence and unknowns

- `docs/database-neutrality/typed-semantics-inventory.md` is the current inventory authority.
- The site switch, scanner/backfill, canonical JSON reads, typed-empty normalization, consumer
  conversions, and v18/v19 lifecycle are **not implemented**.
- Both-database first-party round-trip and object-semantic completion are `Unknown`.
- The disposition of `Customize Form.link_filters`, which has no direct runtime consumer in the
  scanned repository, is `Unknown`.
- No release or production enablement has been performed.
