---
summary: "Drizzle schema, query-layer rules, migrations, and D1 access ownership in packages/db"
read_when:
  - Updating packages/db schemas, queries, migrations, or DB helpers
  - Checking which apps may import @tedix/db and how
title: "Database layer"
---

# Database Layer (packages/db)

Shared platform D1 is accessed only through Drizzle query modules in
`packages/db`. Application layers do not own SQL builders. This doc owns _how_
to model, access, and type the schema; _what_ lives in D1 versus runtime state
is in [data-model.md](./data-model.md).

## Invariants

- `packages/db` is the source of truth for the shared D1 schema and queries.
  `createDbClient()` / `createDbSession()` build the Relations v2 client;
  `createDbQueryClient()` (`@tedix/db/query-client`) builds a relation-free
  client for small Workers. Applications never initialize Drizzle directly.
- Shared-D1 statements live in `packages/db/src/queries/<domain>.ts`, or
  `queries/<domain>/<capability>.ts` for larger domains. Routers, jobs,
  workflows, and services call those helpers; they do not build queries inline.
- Consumers import the exact leaf (`@tedix/db/queries/<domain>[/<capability>]`).
  Query barrels, domain `index.ts` files, and re-export facades are forbidden:
  they hide ownership and defeat lazy loading.
- `drizzle-orm` and `drizzle-kit` are pinned together to one exact prerelease
  in the root catalog. Upgrade both at once and re-verify array-mode selects,
  object-row batches, Relations v2, generation, and the migration ledger.
- Never call `db.transaction()` (D1 rejects `BEGIN`); use `db.batch()`. Never
  select two columns with the same output name. See
  [Query rules on D1](./data-model.md#query-rules-on-d1).
- Tenant scope belongs inside the query. A caller-supplied `organizationId`
  protects nothing unless the SQL predicate uses it.
- Direct `D1Database.prepare()` needs a reviewed entry in
  `scripts/db-access-exceptions.json` and must live in the file that entry
  names. `scripts/lint-db-access.ts` (part of `lint:repo`) fails on an
  unregistered, invalid, or stale owner.

## Who may import `@tedix/db`

Enforced by the Vite+ import lint configuration in `vite.config.ts`:

| Consumer             | Access                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | Client, query modules, DB utilities. Primary control-plane API.                                                   |
| `apps/cms`           | Exact Builder restore-permit owner and its tests only; D1 admission must cover its live bundle and R2 mutations.  |
| `apps/tedi`          | Schema, queries, utils.                                                                                           |
| `apps/cms-runtime`   | Read-only schema and queries (`apps` slug lookup, `tenant_bundles`).                                              |
| `apps/docs`          | Relation-free client and `queries/docs-sites/*`.                                                                  |
| `apps/docs-runtime`  | Relation-free client and `queries/docs-sites/sites`.                                                              |
| `apps/mcp`           | `client`, `queries/mcp-payments`, `queries/rationale-records`, `schema/audit-events`, `schema/mcp-payments` only. |
| `apps/skill-runtime` | `client`, `schema/cognitive` (`skill_runs`) only.                                                                 |
| `apps/tedi-runtime`  | `queries/tedi-runtime-bootstrap` only; its DO SQLite is separate.                                                 |

`apps/os` and `apps/mcp-ui` import only from `@tedix/api-contract`.

### Storage planes

| Plane                           | Owner                                       | Access pattern                                                                         |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Shared platform D1              | `packages/db`                               | Drizzle schema plus direct query leaves; raw SQL only in registered exceptions         |
| Shared-D1 runtime enforcement   | The exact Worker file named in the manifest | Lifecycle, receipt, epoch, or replay fences that must run beside the runtime operation |
| App-owned D1                    | The app's storage module                    | Local schema/query boundary; never a route around the shared query layer               |
| Durable Object / Agent SQLite   | The owning DO/Agent module                  | `ctx.storage.sql`, Agent SQL, or `drizzle-orm/durable-sqlite`; not a D1 exception      |
| Schema migration / provisioning | `packages/db/drizzle/`, provisioning owner  | Reviewed migration ledger or Cloudflare management API                                 |

## Import patterns

```ts
import { apps } from "@tedix/db/schema/apps"; // leaf schema (preferred)
import { apps, appTools } from "@tedix/db/schema"; // aggregated, when cleaner
import { getAppById } from "@tedix/db/queries/app-records";
import { startWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import type { DbClient } from "@tedix/db/client";
import {
	createDbQueryClient,
	type DbQueryClient,
} from "@tedix/db/query-client";
import { parseJsonField } from "@tedix/db/utils/json"; // TEXT columns without mode: "json"
import {
	encryptSecret,
	decryptSecret,
} from "@tedix/db/utils/secrets-encryption";
import { createCatalogVectorClient } from "@tedix/db/vector/catalog";
```

The package export map is the query inventory; `lint:exports` verifies every
repository import.

## Schema

- One schema module per relational domain under `packages/db/src/schema/`; a
  large domain may become a folder. Every table must reach a Drizzle Kit schema
  input. The schema files are the inventory; do not copy table lists into docs.
- SQL names are `snake_case`, TypeScript properties `camelCase`. Do not rename
  a physical index without a real schema reason.
- Infer types with `$inferSelect` / `$inferInsert`; use `<Entity>Row` /
  `New<Entity>Row` when an API entity has the same name.
- JSON columns use `text(..., { mode: "json" }).$type<T>()`. Prefer explicit
  shared types; use `JsonValue` from `@tedix/api-contract/schemas/common` for
  unstructured blobs.
- `text("col", { enum: [...] })` is TypeScript-only; the column is plain `TEXT`,
  so changing enum values needs no migration.
- A TS `.default(sql\`...\`)`applies only when the insert omits the column. If
live DDL has a different default, raw inserts diverge; verify with`db:drift:check`.
- Relations use `defineRelations()` composed from `defineRelationsPart()`
  modules in `relations.ts`. A table needs a relation only when code uses
  `db.query.<table>`.
- Use `drizzle-orm/zod` (`createSelectSchema`, `createInsertSchema`) for
  DB-shaped validators; override only where the API contract is stricter.

### MCP tool columns

`packages/db/src/schema/tools.ts` owns `app_tools`. MCP protocol fields that
affect discovery are first-class columns: `input_schema` (required),
`output_schema`, `annotations`, `icons`, `meta`, `execution_task_support`, and
provenance (`schema_dialect`, `schema_source`, `schema_source_ref`,
`schema_source_hash`, `schema_synced_at`). `config` is only for execution
settings (RPC endpoint, upstream URL, REST method/path, widget layout).

## Queries

- Verb-first names: `get` (one row), `list` (deterministic collection), `find`
  (criteria), explicit mutations (`create`, `update`, `claim`, `reserve`,
  `settle`). Inputs are `Params`, optional behavior `Options`, computed outputs
  `Result`.
- `build*Statement()` returns an unexecuted statement for `db.batch()`
  composition.
- Type a Core-API-only leaf against `DbQueryClient`; use `DbClient` only when
  it needs `db.query.*`.
- Return DB-native rows; routers normalize to contracts.
- Use object-style `where: { id }`, `db.$count(table, filter)`, and
  `.returning()` instead of follow-up reads.
- `db.batch()` runs statements sequentially in one round trip and rolls back
  on failure, but it cannot branch on an earlier result. For read-dependent
  writes use one conditional/CAS statement, a constraint conflict with retry,
  or a Durable Object/Workflow coordinator.
- Drizzle ``sql`...` `` is allowed inside a query module when the typed builder
  cannot express the statement, provided values stay bound, tenant scope is in
  the statement, and output names are unique.

## Notable tables

**Tedi secrets** (`schema/tedi-secrets.ts`, `queries/tedi-secrets.ts`):
per-tedi encrypted keys. HKDF + AES-256-GCM from `SECRETS_MASTER_KEY`, derived
per tedi and secret name; the IV is embedded in `encryptedValue`. Only
`listTediSecrets` is safe for display (metadata only). The runtime materializes
decrypted values into the sandbox environment at sync time.

**Control-plane config** (`schema/control-plane.ts`,
`queries/control-plane/{definitions,revisions}.ts`): `runtime_profiles`
(`config`), `policy_packs` (`definition`, plus `target`), and
`workspace_template_sets` (`templates`). All are append-only versioned
families: `organization_id` NULL means system scope, `status` is
draft/active/archived, and publishing is an `INSERT ... SELECT` compare-and-swap
against the family head. Rows are never updated or deleted. `tedis` pins exact
revision ids in `runtime_profile_id`, `policy_pack_id`, and
`workspace_template_set_id` (always set); rebinds and rollbacks append
`tedi_control_plane_binding_history`.

Tedi-to-app permissions live in Descope FGA (`packages/auth/src/fga.ts`), not
D1.

**Semantic recall.** D1 stays authoritative. Tedi memory recall projects into
Cloudflare Agent Memory (`apps/tedi-runtime/src/agent-memory-projection.ts`);
catalog search uses Cloudflare AI Search (`@tedix/db/vector/catalog`). Their
answers are untrusted context and never decide authorization or lifecycle.

## Migrations

Each migration is a directory `packages/db/drizzle/<timestamp>_<slug>/` with
`migration.sql` and `snapshot.json`. Wrangler reads
`migrations_pattern: "drizzle/*/migration.sql"`. Keep every snapshot: their
`id`/`prevIds` graph lets `drizzle-kit check` detect concurrent branches.
`packages/db/migration-integrity.json` pins each path and SHA-256, so history is
append-only: never rename, reorder, or edit a recorded migration; add a new one.

```bash
bun run db:migrate:generate -- --name <change>
# Review the unrecorded SQL/snapshot; complete authorized annotations first
bun packages/db/scripts/migration-integrity.ts --write
bun run db:schema:check   # non-mutating schema-to-snapshot check
bun run db:migrate:check  # full preflight (below)
bun run db:migrate        # apply pending migrations (needs a D1-scoped token)
bun run db:migrate:list   # confirm nothing is pending
bun run db:drift:check    # read-only compare of the declared schema to live D1
bun run --cwd packages/db db:studio
```

These scripts use the installed, pinned Drizzle Kit, never `bunx drizzle-kit`.
Standard and `--custom` generation leave unrecorded drafts. Review SQL and
snapshot, complete authorized annotations, then run
`bun packages/db/scripts/migration-integrity.ts --write`. This sole first-record
step runs the existing SQL safety checks and requires all snapshots before
writing hashes. Generation (including `no_changes`) never adopts pending drafts;
missing or corrupt recorded history refuses generation.

`db:migrate:check` runs the schema check, `drizzle-kit check`, history and
digest checks, the destructive-DDL and cascade gates, then replays the whole
chain into an isolated local D1 and requires an empty
`PRAGMA foreign_key_check`.

- **Applied baseline.** `APPLIED_BASELINE` in `packages/db/scripts/check-migrations.ts` names
  the newest migration production had applied when history was frozen. The
  destructive, cascade and `PRAGMA foreign_keys` gates judge only migrations
  after it; applied history is protected by `migration-integrity.json`.
- **Destructive DDL gate.** Drops, table renames/recreation,
  or row deletion fail unless the SQL carries
  `-- tedix: destructive-reviewed Work-Item: <uuid>`, pointing at a reviewed
  export/verify/rollback plan. The directive records review; it does not make
  the migration safe. FK disablement always refuses: D1 ignores it inside the
  migration transaction, and a review directive cannot excuse it.
- **Cascade gate.** Before every `DROP TABLE` or rename, the replay reads
  `pragma_foreign_key_list` and fails if another table references the target
  `ON DELETE CASCADE`. D1 ignores `PRAGMA foreign_keys=OFF` inside an applied
  migration, so drizzle-kit's rebuild header does not protect child rows. An
  intended deletion is acknowledged per table with
  `-- tedix: cascade-reviewed Work-Item: <uuid> Table: <table>`.
- **Live drift.** `db:drift:check` reports `current`, `acknowledged`, `drift`
  (fails), or `unverified` (warns; never a silent pass). Acknowledged
  differences are exact table/column/property entries in
  `packages/db/scripts/schema-description.ts`; an entry the live schema no
  longer shows fails as stale.

Production applies run before Worker deploys, record a D1 Time Travel bookmark
first, and verify the live ledger and zero drift afterward. Wrangler rolls back
a failing migration; recovering from a migration that succeeded with wrong
effects is a manual Time Travel restore, never automatic.

## References

- [Cloudflare D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Drizzle with Cloudflare D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)
- [Drizzle Relations v2](https://orm.drizzle.team/docs/relations)
- [Drizzle Kit check](https://orm.drizzle.team/docs/drizzle-kit-check)
- [Drizzle Zod](https://orm.drizzle.team/docs/zod)
