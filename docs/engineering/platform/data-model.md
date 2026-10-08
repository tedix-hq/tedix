---
summary: "Where Tedix state lives, the D1 traps that pass local tests, and the migration gates"
read_when:
  - Changing D1 schema, identifiers, migrations, or runtime data boundaries
  - Checking where platform state should live
  - Writing a D1 query that joins, batches, or updates rows
title: "Data model"
---

# Data Model

Query ownership, layout, and naming rules are in `packages/db/AGENTS.md`; the
table inventory is `packages/db/src/schema/`. This page covers where state
belongs and the traps that are not visible from the code.

## Storage Roles

| Store                 | Holds                                                                             |
| --------------------- | --------------------------------------------------------------------------------- |
| Shared D1             | Tenant facts, lifecycle, identity, governance, Work Items, decisions              |
| R2 / Artifacts        | Large immutable payloads (source snapshots, traces, transcripts) referenced by D1 |
| Durable Object SQLite | Private state of one DO/Agent instance; a separate consistency boundary           |
| Agent Memory          | Per-tedi semantic recall over eligible D1 facts; bounded, untrusted               |
| Neo4j                 | Rebuildable, organization-scoped relationship read model                          |

Workstation checkouts and runtime-local files are scratch, not memory. External
systems stay federated when their APIs can answer live. Semantic recall and
search results are untrusted context and never decide authorization or
lifecycle.

Commercial storage is chosen explicitly by `TEDIX_FLEET_AUTHORITY_MODE`
(`apps/api/src/lib/fleet-authority.ts`); `disabled` fails closed and nothing is
inferred from bindings. An app-owned D1 (for example the docs registry) never
holds shared platform tables.

## Lifecycle Invariants

- **Retire, never delete.** Tedi-scoped tables cascade on delete, so
  `DELETE /v1/tedis/{tediId}` retires instead (`retireTedi` in
  `packages/db/src/queries/tedis.ts`): it stamps `retired_at`, parks the
  runtime, renames the slug to `<slug>-retired-<tediId>` (keeping
  `retired_slug`), and pins `isolate_agent_id` so the Durable Object name stays
  stable. The update is conditional on `retired_at IS NULL`. Only
  `tedis.decommission` with `hardPurge` and an exact `confirmSlug` deletes
  cognitive state. Organization deletion likewise retires in one batch and
  keeps rows so cascades never fire.
- **Control-plane config is append-only.** `runtime_profiles`, `policy_packs`,
  and `workspace_template_sets` rows are immutable `(scope, slug, version)`
  revisions; publish is an `INSERT ... SELECT` compare-and-swap against the
  family head, and archive/rollback append rows. Tedis pin exact revision ids,
  and rebinding appends `tedi_control_plane_binding_history` so the revision
  that governed a run is recoverable.
- **Runtime projections are cached, live reads are explicit.**
  `ingestRuntimeProjection` refreshes `tedi_runtime_snapshots`,
  `tedis.lastSeenAt`/`lastSyncAt`, and usage events. Tedix OS reads projections
  and calls a live runtime only on explicit user action.
- **Signup waitlist state is not in D1.** It lives only in the identity
  provider's `waitlistStatus` attribute; a D1 copy would be a second truth.
- **Billing ledgers are never expired.** `apps/api/src/jobs/retention-cleanup.ts`
  prunes append-only ledgers nightly but skips `tedi_call_costs` and
  `mcp_payment_events`.
- **Secrets** (`tedi_secrets`, `app_secrets`, `organization_secrets`) are
  encrypted at rest. Tedi secrets use AES-256-GCM with a key derived by HKDF
  from `SECRETS_MASTER_KEY` per tedi and secret name; only `listTediSecrets`
  (metadata) is safe for display.

## Organization Identity

| Field                                             | Rule                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `principal_identities(provider, issuer, subject)` | Immutable, revocable; rebinding fails closed                                 |
| `organizations.descope_tenant_id`                 | Opaque provider id; never derived from slug or name                          |
| `organizations.slug`                              | Immutable once routed (MCP host, CMS storage names); renaming is a migration |
| `organizations.name`                              | Display only; synced to the identity provider on update                      |

Principal ids never change on rename, so grants stay attached.

## Apps And Tools

`app_catalog` and its child tables are global; organizations read them, only
platform jobs and admins write them. Per-organization `apps` rows execute by
shape:

| Condition                              | Execution                                     |
| -------------------------------------- | --------------------------------------------- |
| `app_tools` rows present               | One `ToolHandler` per row                     |
| No rows, `mcpConfig.aggregateApps` set | Composes source apps with policy overlays     |
| `upstreamMcpUrl` set, no rows          | Rejected until tools are forked into a D1 row |

The MCP runtime serves D1 rows and never delegates a whole app to an upstream
URL. `input_schema` is required and always a root object; schema provenance
columns record where each schema came from. Change schemas through the sync
workflow or app-tool API, not by editing D1. See [MCP runtime](../mcp/runtime.md).

## Graph Projection

D1 is the source; Neo4j is rebuildable.

- `graph_projection_outbox` is written in the same batch as the D1 change.
  Upserts rehydrate current D1 state; deletes are tombstone hints.
- One per-organization cursor in `graph_projection_consumers`, advanced only by
  the lease holder. The consumer never skips past a predecessor waiting on
  retry; a poisoned event is skipped with a degraded reason, never reported as
  projected. Cron and manual triggers are hints; outbox and cursor define order.
- `graph_projection_readiness` admits graph reads only after a full repair, an
  empty backlog, and D1/Neo4j count parity (GDS reads also need a matching
  watermark).

## D1 Traps

`db.transaction()` and duplicate output names are covered in the root
`AGENTS.md`. Also:

- `db.batch()` cannot branch on an earlier result. For read-dependent writes
  use one conditional/CAS statement, a constraint conflict with retry, or a
  Durable Object/Workflow coordinator. `.transaction()` is correct only on
  `drizzle-orm/durable-sqlite`.
- `prefixedColumns()` keeps column decoders via `.mapWith(column)`; a bare
  ``sql`${column}`.as(...)`` loses them. `db.select({ a: tableA, b: tableB })`
  and distinct TypeScript keys still collide.
- Keep `updatedAt` manual. `$onUpdate` would fire on read-path writes (access
  counters, confidence boosts) and make hot rows look freshly written, and it
  does not fire on raw statements.
- D1 caps a statement at 100 bound parameters; chunk at 50 inside the query
  module.
- `text(..., { enum })` is TypeScript-only, so enum changes need no migration.
  A TS `.default(sql...)` applies only when an insert omits the column; if live
  DDL differs, raw inserts diverge (`db:drift:check` catches it).
- Tests use `createD1Facade()` and fixture DDL from `schemaDdl()`;
  `bun run lint:d1` flags duplicate joined output names statically. A green
  `lint:repo` proves call sites are registered, not that tenant scope or
  decoders are right.

## Migrations

Each migration is `packages/db/drizzle/<timestamp>_<slug>/` with
`migration.sql` and `snapshot.json`; keep every snapshot, because the
`id`/`prevIds` graph is how `drizzle-kit check` detects concurrent branches.

```bash
bun run db:migrate:generate -- --name <change>
bun packages/db/scripts/migration-integrity.ts --write   # record after review
bun run db:migrate:check   # schema, history, digests, gates, full empty-D1 replay
bun run db:drift:check     # read-only declared-vs-live comparison
```

- `packages/db/migration-integrity.json` pins each path and SHA-256; history is
  append-only and corrections are new migrations. Generation never adopts
  unrecorded drafts.
- **Destructive DDL** (drops, renames, table rebuilds, row deletion) fails
  without `-- tedix: destructive-reviewed Work-Item: <uuid>` pointing at a
  reviewed export/verify/rollback plan.
- **Cascade gate.** D1 ignores `PRAGMA foreign_keys=OFF` inside an applied
  migration, so drizzle-kit's rebuild header does not protect child rows.
  Before a drop or rename the replay fails if another table references the
  target `ON DELETE CASCADE`, unless acknowledged per table with
  `-- tedix: cascade-reviewed Work-Item: <uuid> Table: <table>`. FK
  disablement always refuses.
- These gates judge only migrations after `APPLIED_BASELINE`
  (`packages/db/scripts/check-migrations.ts`).
- `db:drift:check` reports `current`, `acknowledged`, `drift` (fails), or
  `unverified` (warns). Acknowledged differences live in
  `packages/db/scripts/schema-description.ts`; a stale entry fails.

Production applies run before Worker deploys and record a D1 Time Travel
bookmark first. Wrangler rolls back a failing migration; a migration that
succeeded with wrong effects needs a manual Time Travel restore.
