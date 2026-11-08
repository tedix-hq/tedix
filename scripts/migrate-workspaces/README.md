# Move every workspace into its own workspace object

One-shot copy of workspace data out of the shared database into one object
per workspace, with a reconciler that proves the copy before anything old is
removed. The operator runbook is `docs/public/workspace-migration.md`; this
file is the reference for the commands and their contracts.

## Commands

```bash
bun scripts/migrate-workspaces/cli.ts export    --snapshot main.sql --logs logs-1.sql logs-2.sql --assignments assignments.json --bundles r2://<bucket>/<prefix>
bun scripts/migrate-workspaces/cli.ts import    --bundles r2://<bucket>/<prefix> --remote https://<worker-host>
bun scripts/migrate-workspaces/cli.ts reconcile --bundles r2://<bucket>/<prefix> --remote https://<worker-host> --snapshot main.sql --logs logs-1.sql --report reconcile.json
bun scripts/migrate-workspaces/cli.ts rehearse  --snapshot main.sql --logs logs-1.sql --assignments assignments.json --report rehearsal.json
bun scripts/migrate-workspaces/cli.ts schema-check --snapshot main.sql --logs logs-1.sql
bun scripts/migrate-workspaces/cli.ts assignments --snapshot main.sql --out assignments.json
```

- `export` reads one snapshot of the shared database (`wrangler d1 export`
  output or a `.sqlite` file) for the main database and every log partition,
  and writes one bundle per workspace: `manifest.json` plus a `<table>.jsonl`
  per moved table. A `.sql` snapshot is loaded into `<file>.sqlite` once and
  reused. Rows are copied as stored.
- `import` loads each bundle into the workspace's object in chunks of 1000
  rows. Every chunk has a stable batch id, so a rerun skips chunks that
  already landed. Tables are loaded in the order of the mapping file.
- `reconcile` compares each bundle with its object: row count and one
  content hash per table, the serving revision and latest revision of every
  output, the object's identity and its jurisdiction (`eu` is required; pass
  `--allow-any-jurisdiction` only for a local rehearsal). With `--snapshot`
  it also proves that every row that should move is in exactly one bundle.
  It prints a report and exits non-zero on any difference.
- `rehearse` runs export, import and reconcile against a copy on this
  machine and prints the time each step took per workspace and in total.
  Pass `--work-dir <dir> --keep` to inspect the bundles and objects after.

- `schema-check` compares, for every mapped table, the snapshot's columns
  with the columns the object's migration chain creates, and lists tables
  the chain does not create yet. Run it before `import`; it exits non-zero
  on any finding.
- `assignments --out assignments.json` proposes the per-organization homes
  (the oldest active workspace) for a person to review.

`--bundles` is a directory or `r2://bucket/prefix`. R2 objects are written
with `wrangler r2 object put --jurisdiction eu` through a local staging
directory; `export` also writes `index.json` listing the bundles.

`--remote` needs `MIGRATE_WORKSPACES_TOKEN` in the environment. `--objects
<dir>` targets local SQLite files instead, one per workspace, shaped by the
object's own migration chain (`packages/db/tenant-store-drizzle`).

## The mapping

`tables.ts` is the only place that decides what moves. Each entry names the
table, the rows one workspace owns, the stores to read (main, or main plus
every log partition), the key the reconciler sorts and hashes by, and the
rows that move at all. Rows without a workspace column follow their
conversation (runs, run events, tool results, artifacts) or the
organization's assignment:

```json
{
	"<organization id>": {
		"memoryHome": "<workspace id that receives the organization's memory>",
		"unassignedOutputsHome": "<workspace id that receives outputs with no workspace>"
	}
}
```

`export` refuses to start when an organization has memory rows or
workspace-less outputs and no assignment, or names a workspace the
organization does not have. Reassigned outputs get the home workspace
written into `workspace_id`; the bundle manifest records how many.

Two more cases the production data has: a live organization with memory
but no workspace at all gets one when its entry carries `"createHome":
true` (the export writes the directory row of a workspace named Home with
the id in `memoryHome`); and memory rows of an organization that no longer
exists stay in the shared database, counted as `staying` in the
reconciler's totals, and go with the old tables. `assignments` proposes
both.

A table the object derives itself (`memory_fact_citations`, rebuilt from
each fact's consolidation metadata by the object's own trigger) is marked
`derivedInObject`: `import` skips it and `reconcile` compares what the
object built with the source on the key columns.

What stays in the shared core, with the reason, is `TABLES_THAT_STAY` in the
same file: the workspace directory, factory runs and their artifacts, a
tedi's own ledger, and organization Home threads (conversations with no
workspace) together with their runs and events.

## Remote protocol

The worker that hosts the workspace objects serves three routes under
`/migration/workspaces/:organizationId/:workspaceId`, each requiring
`Authorization: Bearer <MIGRATE_WORKSPACES_TOKEN>` and forwarding to the
object named by `tenantStoreName({ organizationId, workspaceId })` on the
jurisdiction-selected namespace:

| Route            | Body                                      | Answer                                                                 |
| ---------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `GET` (describe) | none                                      | `{ organizationId, workspaceId, createdAt, migrations, jurisdiction }` |
| `POST /import`   | `{ batchId, table, rows }`                | `{ batchId, table, rowCount, status: "imported" \| "duplicate" }`      |
| `POST /rows`     | `{ table, after: string \| null, limit }` | `{ rows, next: string \| null }`                                       |

`describe` returns the object's `describe(scope)` plus the jurisdiction the
worker addressed it with (`DO_JURISDICTION`). `import` is the object's
`importRows(scope, batch)`. `rows` walks a table in a stable order and
returns an opaque cursor; the local implementation uses `rowid`. Row values
travel as JSON; a blob is `{ "$b64": "<base64>" }`.

## Tests

```bash
bun test scripts/migrate-workspaces/
bun run type-check:scripts
```

The test builds the shared database from its real migration chain, with run
events split across a main store and a log partition, and runs the full
rehearsal, drift detection, rerun idempotency and the refusals.
