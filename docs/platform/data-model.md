---
summary: "Where Tedix state lives: D1 vs runtime, storage planes, catalog layers, organization identity, and D1 query rules"
read_when:
  - Changing D1 schema, identifiers, or runtime data boundaries
  - Checking where platform state should live
  - Writing a D1 query that joins, batches, or updates rows
title: "Data model"
---

# Data Model

This page owns _what_ lives where: the D1-vs-runtime split, storage planes,
identifiers, and the D1 query rules. For _how_ to write schema and queries
(Drizzle, migrations, module layout) see [DB](db.md). The table list itself
lives in `packages/db/src/schema/`; this page does not enumerate it.

```text
Tedix OS (TanStack Router + Query)
    ↓ oRPC
API (Workers + D1)
    ↓ Service Binding
Tedi runtime (Agents/Pi Worker + Durable Object)
    ↓ optional lease
Workstation runtime (containers for OS/process work)
```

## Storage Roles

| Store          | Holds                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| Git            | Code, schemas, migrations, docs, decisions                                               |
| D1             | Tenant facts, lifecycle, identity, governance, Work Items, decisions, projection control |
| R2 / Artifacts | Large immutable payloads (source snapshots, traces, transcripts) referenced from D1      |
| Agent Memory   | Per-tedi semantic recall over eligible D1 facts; results are bounded and untrusted       |
| Neo4j          | Rebuildable, organization-scoped relationship read model                                 |

Workstation checkouts and runtime-local files are not long-term memory. External
systems stay federated when their APIs can answer live; Tedix snapshots into R2
and D1 only when a stable copy is required.

## Relational Storage Planes

| Plane                         | Scope                                                       | Query owner                                                                              |
| ----------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Shared platform D1            | Multi-tenant control-plane facts shared by all Workers      | `packages/db` schema and query modules, imported by direct `@tedix/db/queries/...` paths |
| Commercial seam               | Commercial storage chosen by `TEDIX_FLEET_AUTHORITY_MODE`   | `apps/api/src/lib/fleet-authority.ts`; `disabled` fails closed, nothing is inferred      |
| Shared-D1 runtime enforcement | Narrow lifecycle, receipt, epoch, or replay fences          | The exact Worker storage owner listed in `scripts/db-access-exceptions.json`             |
| App-owned D1                  | A dedicated product database (for example a docs registry)  | The app's storage module; never shared platform tables                                   |
| Durable Object SQLite         | Private, strongly consistent state of one DO/Agent instance | The owning runtime module (native SQL or `drizzle-orm/durable-sqlite`)                   |
| Migrations / provisioning     | Schema and database lifecycle                               | Append-only generated migrations under `packages/db/drizzle/`                            |

Routers, workflows, and jobs may create a Drizzle client but delegate every
shared-D1 statement to a package query helper. Direct `D1Database.prepare()` is
allowed only for entries in `scripts/db-access-exceptions.json`, whose file,
plane, binding, owner, and reason `lint:repo` checks. Applied migrations are
frozen by path and SQL digest in `packages/db/migration-integrity.json`;
corrections are always new migrations.

## Data Categories

### Stored in D1

User-configured values managed through Tedix OS or the API. A few `tedis`
fields (`runtimeStatus`, `lastSeenAt`, `lastSyncAt`, `runtimeVersion`) are
projections refreshed from the runtime.

| Data                | Location                                                          | Notes                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tedi identity       | `tedis.*`                                                         | Name, slug, display name, language, timezone, avatar                                                                                                                                                       |
| Channels            | `tedis.channels`                                                  | Channel config; credentials live in encrypted secrets                                                                                                                                                      |
| Governance          | `tedis.toolPolicy`, `budgets`, `quietHours`, `governanceOverride` | `governanceOverride.requiresApproval` beats the policy pack; otherwise pack signals decide; unknown defaults to gated (`deriveRequiresApproval` in `apps/api/src/rpc/routers/kernel/tedi-capabilities.ts`) |
| Platform permission | `tedis.mcp_capability_profile`                                    | What a tedi may do. `resolveTediScopes` (`packages/mcp/src/auth/scopes.ts`) maps `standard`, `org_admin`, `platform_admin` to scopes. Identity-provider roles are never projected into tedi tokens.        |
| Retirement          | `tedis.retiredAt`, `tedis.retiredSlug`                            | Soft delete. Tedi-scoped tables cascade on delete, so `DELETE /tedis/{tediId}` retires the row and renames the slug instead; only `tedis.decommission` with `hardPurge` removes it                         |
| Org retirement      | `organizations.metadata.retiredAt`, `retiredSlug`                 | `organizations.delete` retires in one batch (tedis, API keys, apps, memberships) and keeps rows so cascades never fire                                                                                     |
| Secrets             | `tedi_secrets`, `app_secrets`, `organization_secrets`             | Encrypted at rest                                                                                                                                                                                          |

### Control-plane configuration

`runtime_profiles`, `policy_packs`, and `workspace_template_sets` define what a
tedi runs, how it behaves, and which files bootstrap its workspace. Every row
is an immutable revision identified by `(scope, slug, version)`; publish,
archive, and rollback append rows. `tedis.runtime_profile_id`,
`policy_pack_id`, and `workspace_template_set_id` pin exact revisions, and
rebinding appends `tedi_control_plane_binding_history` so the revision that
governed a run can be recovered.

### Live runtime reads

These need a live runtime connection (or an active workstation lease) and can
take seconds:

| Data                    | Endpoint                                                   |
| ----------------------- | ---------------------------------------------------------- |
| Worker health           | `GET /health`                                              |
| Runtime status          | `GET /api/status`                                          |
| Detailed runtime status | `GET /api/admin/status/detailed`                           |
| Channels / devices      | `GET /api/admin/channels/status`, `GET /api/admin/devices` |
| Agent turns             | Service-binding inject                                     |

### Projections cached in D1

`ingestRuntimeProjection` stores runtime snapshots for fast reads:
`tedi_runtime_snapshots` (runtime, channel, device status, version),
`tedis.lastSeenAt`, `tedis.lastSyncAt`, and `tedi_usage_events`.

Tedix OS reads projections by default and makes live runtime calls only on
explicit user action.

### Deliberately not in D1

- **Signup waitlist state** lives only in the identity provider's
  `waitlistStatus` user attribute, read and written by
  `apps/api/src/rpc/routers/waitlist.ts`. A D1 copy would be a second truth.

## App Catalog

Two layers. Organizations can read the catalog layer but only platform jobs
and admin operations write it.

**Catalog layer (global).** `app_catalog` has one row per MCP endpoint or
logical app, with `tool_source` (`upstream_mcp`, `tedix_app`, `openapi`).
Child tables hold store listings, tool/resource/prompt snapshots, tool tests,
health history, and a field-level change log; `upstream_drift_reports` tracks
divergence between a live upstream and its snapshot. Tedix-owned sources
project their snapshot from the linked base app's `app_tools` and never produce
drift reports.

**Instance layer (per organization).** `apps` rows belong to an organization;
`app_tools` holds tool definitions.

| Condition                              | App type                                | Tool execution                             |
| -------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `app_tools` rows present               | Base app, generated app, or custom fork | `ToolHandler` per `app_tools` row          |
| No rows, `mcpConfig.aggregateApps` set | Tenant proxy or aggregator              | Composes source apps with policy overlays  |
| `upstreamMcpUrl` set, no rows          | Invalid                                 | Rejected until tools are forked into a row |

The MCP runtime serves D1 rows; it never delegates a whole app to an upstream
URL. See [MCP runtime](../mcp/runtime.md).

**Schema provenance.** `input_schema` is required and always a root object.
Runtime and catalog tool rows carry `schemaDialect`, `schemaSource`,
`schemaSourceRef`, `schemaSourceHash`, and `schemaSyncedAt`. RPC tools derive
from oRPC contracts (non-object results use a `{ data }` envelope), MCP tools
from upstream `tools/list`, and REST tools from OpenAPI via
`mcpConfig.openApiSync`. Change schemas through the sync workflow or app-tool
API, not by editing D1.

## Graph Projection

D1 is the source; Neo4j is a projection that can be rebuilt.

- `graph_projection_outbox` records mutations in the same batch as the D1
  write. Upserts rehydrate current D1 state; deletes are tombstone hints.
- `graph_projection_consumers` holds one per-organization cursor, advanced only
  by the current lease holder.
- `graph_projection_readiness` decides whether graph reads are allowed and
  tracks repair progress.
- `graph_projection_maintenance_runs` records explicit graph maintenance; its
  MCP task id equals the Workflow instance id.

The consumer never skips ahead of a predecessor waiting on retry. A poisoned
event is skipped with a degraded reason and never reported as projected. Cron
and manual triggers are hints; the outbox and cursor define order. Reads are
admitted only after a full repair, an empty backlog, and count parity between
D1 and Neo4j; derived GDS reads also need a matching GDS watermark.

Code: `packages/db/src/queries/graph-projection.ts`,
`packages/db/src/queries/graph-projection-maintenance.ts`,
`apps/api/src/services/graph-projection-{drain,certification,schema,algorithms}.ts`,
`apps/api/src/workflows/graph-gds-refresh-workflow.ts`.

## Telemetry And Retention

- `audit_events` is the platform audit trail (actions such as `tedi.provision`,
  `tedi.retire`, `tedi.governance.updated`, `tedi.purge`).
- `platform_cron_executions` stores one start and one terminal record per
  scheduled run, unique on `(schedule_id, scheduled_at)`.
- Inbound MCP tool-call metrics go to Analytics Engine; a tedi's outbound calls
  are recorded in `tedi_runtime_events`.

`apps/api/src/jobs/retention-cleanup.ts` (nightly) prunes append-only ledgers
on fixed windows. `tedi_call_costs` and `mcp_payment_events` are never expired
by schedule because they are billing records.

## Organization Identity

| Field                                             | Mutability            | Role                                                                                                                     |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `principal_identities(provider, issuer, subject)` | Immutable, revocable  | Auth join: maps one external identity to one Tedix principal and rejects rebinding                                       |
| `organizations.descope_tenant_id`                 | Adapter-owned         | Opaque identity-provider tenant id; never derived from slug or name                                                      |
| `organizations.slug`                              | Immutable once routed | Routing and infrastructure key (`{slug}.mcp.tedix.dev`, CMS storage names); renaming needs a coordinated infra migration |
| `organizations.name`                              | Mutable               | Display only; `organizations.update` syncs it to the identity provider                                                   |

Principal ids and their mappings never change on rename, so grants and
relationships stay attached.

## Schema And Relations

- Tables are `sqliteTable()` definitions in `packages/db/src/schema/`.
- Relations use Drizzle Relations v2. Every table used through `db.query` must
  be in the schema passed to `defineRelations()`; `relations.test.ts` pins
  coverage.
- Query modules live at `packages/db/src/queries/<domain>.ts` or
  `packages/db/src/queries/<domain>/<capability>.ts`, with no aggregating
  `index.ts`.

## Query Rules On D1

### Ownership first

Put shared-D1 statements in the domain query module and call them by exact
path. Apps own authentication, validation, orchestration, and contract
normalization; query helpers own tenant predicates, ordering, pagination,
atomic statement builders, and result types. Use typed Drizzle builders or
`db.query.*` by default; Drizzle `sql`...`` is an acceptable escape hatch inside
the query module as long as values stay bound and tenant scope is in the
statement.

Two Drizzle idioms are valid SQL, pass local tests, and fail on real D1.

### Never `db.transaction()`; use `db.batch()`

D1 rejects the `BEGIN`/`SAVEPOINT` statements the Drizzle D1 driver emits for
`.transaction()`. `db.batch()` runs in an implicit transaction. To keep
multi-write work atomic, write a builder that returns the unexecuted statement
and compose it into a batch (for example `buildProvisionBillingAccountStatement`
in `packages/db/src/queries/billing/plans.ts`). `lint:repo` rejects
`db.transaction()` in D1-backed code. `.transaction()` is correct on
`drizzle-orm/durable-sqlite`.

### Unique selected output names

`db.batch()` returns object rows, so duplicate column names collapse before
Drizzle maps them back to positions, silently shifting values or breaking JSON
decoding. Every join must select unique output names, even if it is not batched
today, because a helper may be composed into a batch later. All of these
collide:

```typescript
db.select().from(a).innerJoin(b, ...)          // shared column names
db.select({ account: accounts, plan: plans })  // looks namespaced, is not
db.select({ factId: a.id, domainId: b.id })    // distinct TS keys do not help
```

Use `prefixedColumns(table, prefix)` from `packages/db/src/utils/select.ts`. It
keeps the nested result shape and preserves column decoders via
`.mapWith(column)`; a bare `sql`${column}`.as(...)` loses them. Relational
Queries v2 is safe on its own.

### Keep `updatedAt` manual

Do not add `$onUpdate` to `updatedAt`. It fires on every Drizzle update,
including read-path writes such as access counters and confidence boosts, which
would make frequently read rows look freshly written to anything that ranks by
`updatedAt`. It also does not fire on raw statements. Decide per write whether
it changes content.

### Test doubles no looser than D1

Use `createD1Facade()` (`packages/db/src/test/d1-facade.ts`), which rejects
both failure modes above, and derive fixture DDL with `schemaDdl()`
(`ddl-fidelity.test.ts` rejects hand-written DDL that drifts from the schema).
`bun run lint:d1` (`scripts/lint-d1.ts`) statically flags duplicate output
names in joined selects across `apps/` and `packages/`.

### Bound parameters

D1 caps a statement at 100 bound parameters. Keep chunks at 50 or fewer and do
the chunking inside the query module.

### Non-guarantees

A green `lint:repo` means there are no unregistered call sites. It does not
prove tenant scoping or decoder behavior; those need focused tests in the query
owner. When a raw path moves to Drizzle, remove its exception entry in the same
change.
