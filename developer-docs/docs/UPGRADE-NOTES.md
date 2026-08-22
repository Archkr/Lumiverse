# Upgrade Notes

## 2026-08-22 — Provider-broker subsystem migrations (102–104)

The provider-broker subsystem ships with three database migrations:

| Migration | What it does |
|---|---|
| `102_spindle_provider_scope` | Adds a `scope` column (`system \| operator:<id> \| user:<subject>`) to `extension_grants` and backfills it from each extension's install scope / installing user. |
| `103_edit_and_send_outbox` | Adds the durable edit-and-send request log (`edit_and_send_requests`) and the crash-resilient generation outbox (`generation_outbox`), plus a `revision` OCC column on `messages`. |
| `104_extension_grants_scoped_unique` | Rebuilds `extension_grants` so uniqueness is per-scope: `UNIQUE(extension_id, permission, scope)` instead of `UNIQUE(extension_id, permission)`. |

!!! warning "Operator-upgrade-relevant: migration 104"
    Migration 104 is a **table-recreation migration**: it creates `extension_grants_new`, copies all rows, drops the original table, and renames. The unique constraint change means the same permission can now be granted to one extension in distinct scopes — existing duplicate-grant rows are preserved as separate scoped rows rather than collapsed. Operators should verify extension grants after upgrading, since grant lookups that previously matched on `(extension_id, permission)` alone now also depend on `scope`.

## 2026-08-22 — Spindle provider registration permissions are now privileged

The `providers.embedding.register`, `providers.tts.register`, `providers.stt.register`,
and `providers.sidecar.register` permissions are now **PRIVILEGED**. Existing deployed
provider extensions that relied on implicit registration grants will lose the ability
to register their providers after upgrading; an operator must explicitly grant these
permissions per extension.
