# Move every workspace into its own workspace object

One-shot copy of workspace data out of the shared database into one object
per workspace, with a reconciler that proves the copy before anything old is
removed. The operator runbook is `docs/public/workspace-migration.md`; this
file is the reference for the commands and their contracts.

## Commands

```bash
bun scripts/migrate-workspaces/cli.ts capture --config capture-config.json --out /private/capture [--page-size 100] [--delay-ms 2000] [--delay-file /private/delay-ms]
bun scripts/migrate-workspaces/cli.ts export    --snapshot main.sql --logs logs-1.sql logs-2.sql --assignments assignments.json --bundles r2://<bucket>/<prefix> [--scope <org>/<workspace>]
bun scripts/migrate-workspaces/cli.ts import    --bundles r2://<bucket>/<prefix> --remote https://<mcp-host> --auth tedix --snapshot main.sql --logs logs-1.sql logs-2.sql [--scope <org>/<workspace>]
bun scripts/migrate-workspaces/cli.ts reconcile --bundles r2://<bucket>/<prefix> --remote https://<mcp-host> --auth tedix --snapshot main.sql --logs logs-1.sql logs-2.sql [--scope <org>/<workspace>] --report reconcile.json
bun scripts/migrate-workspaces/cli.ts rehearse  --snapshot main.sql --logs logs-1.sql --assignments assignments.json --report rehearsal.json
bun scripts/migrate-workspaces/cli.ts schema-check --snapshot main.sql --logs logs-1.sql
bun scripts/migrate-workspaces/cli.ts assignments --snapshot main.sql --out assignments.json
```

- `capture` uses the audited D1 HTTP query API for the nine mapped main
  tables and only the moved conversations' runtime events in each log store.
  Its private configuration names `accountId`, `mainDatabaseId`, every
  `logDatabaseIds` entry and reviewed `assignments` (the home choices below).
  Set `CLOUDFLARE_API_TOKEN` using the installation's authorized credential.
  Schema and partition metadata are read separately; organization identities
  are derived locally from workspace directory rows.
  Reads are serial keyset pages bounded by a recorded source rowid. The delay
  defaults to two seconds and cannot be lower. Overload, 7429, temporarily
  unavailable, 429 and 503 responses back off at least 30 seconds and increase
  the subsequent delay. A monitor can raise the delay by writing milliseconds
  to `--delay-file`; it never lowers an existing delay.
  Restart the same command and directory to resume. `cursor.sqlite` commits
  each page with its checkpoint; `cursor.json` is its readable mirror.
  Keep one process per capture directory. Completed captures retain their
  original end time on rerun and cannot be refreshed by rerunning the command.
  The resulting `manifest.json` records capture times, per-store counts and
  hashes, partition coverage, high-water marks and request/backoff totals.
  Pass it as `--snapshot /private/capture/manifest.json` to the other commands
  without `--logs`; export and rehearsal use its reviewed assignments unless
  an explicit assignments file is supplied. Validation recomputes its hashes,
  checks every recorded partition and keeps the existing historical checks.
  Freshness uses capture end time. Full-export validation is unchanged.
  Capture is a moving read for additive staging. For timestamped tables,
  reconciliation separates rows updated after the mark as expected re-reads.
  For tables bounded by rowid, new target keys need a source re-read to verify
  their rowid is above the mark. Both remain unready for cutover until re-read;
  existing-row changes without a timestamp remain drift. No capture or
  reconciliation command freezes writes or authorizes activation.
- `export` reads one snapshot of the shared database (`wrangler d1 export`
  output or a `.sqlite` file) for the main database and every log partition,
  and writes one bundle per workspace: `manifest.json` plus a `<table>.jsonl`
  per moved table. A `.sql` snapshot is loaded into `<file>.sqlite` once and
  reused. Rows are copied as stored. Every bundle manifest carries the
  snapshot's own manifest: when it was taken (the oldest file's time), and
  per store (main and each log partition, with its `log_partition` row) the
  row count and one hash of every mapped table.
- `import` loads each bundle into the workspace's object in chunks of 1000
  rows. Every chunk has a content-based batch id. Before opening the target,
  it checks every table's count and full-row hash against the manifest.
  Before writing a workspace, it compares all existing rows: identical rows
  are counted as duplicates, missing rows are added, and a conflicting row
  stops the import. Object-native rows are preserved and still appear in
  the reconcile report.
  Tables are loaded in the order of the mapping file. A remote import
  needs `--snapshot` and `--logs` and refuses, before it contacts any
  object, unless both gates hold (`snapshot-proof.ts`; no override flag):
  1. **A validated full snapshot, taken at import time.** At least one log
     partition; each is a log partition (has a `log_partition` table); an
     unranged partition is the only one, otherwise exactly one is active,
     it is the newest, and the ranges do not overlap. The snapshot is at
     most two hours old, and its manifest equals the one in every bundle.
  2. **Historical log coverage.** The partitions' ranges reach back to the
     oldest run, each partition holds only events inside its range, every
     run that recorded events (`latest_event_at`) has them in the snapshot,
     and every row that should move is in its bundle. This is the same
     check `reconcile --snapshot` runs.
- `reconcile` compares each bundle with its object: row count and one
  content hash per table, the serving revision and latest revision of every
  output, the object's identity and its jurisdiction (`eu` is required; pass
  `--allow-any-jurisdiction` only for a local rehearsal). With `--snapshot`
  it also proves that every row that should move is in exactly one bundle
  and that the log partitions cover every run's history. It prints a
  report and exits non-zero on any difference.
- `--scope <org>/<workspace>[,...]` limits `export`, `import` and
  `reconcile` to the named workspaces, so the move can go one customer at
  a time. Scoped coverage collects each workspace's rows from the snapshot
  again and requires them to equal its bundle row for row.
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

`--remote` with `--auth tedix` signs each call with the Tedix login that
`tedix login -w connect` stored (a platform administrator) and goes through the
MCP gateway's `/admin/migration/...` door, which forwards to the workspace
objects and adds their own token; `--workspace <name>` picks another stored
login. Without `--auth tedix`, `--remote` talks to the hosting worker directly
and needs `MIGRATE_WORKSPACES_TOKEN` in the environment. `--objects
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
		"unassignedOutputsHome": "<workspace id that receives outputs with no workspace>"
	}
}
```

Organization memory (`memory_*`) does not move. It stays in the
organization database with today's permissions; the workspace objects'
import route refuses those tables.

`export` refuses to start when an organization has workspace-less outputs
and no assignment, or names a workspace the organization does not have.
Reassigned outputs get the home workspace written into `workspace_id`; the
bundle manifest records how many. A live organization with such outputs
but no workspace at all gets one when its entry carries `"createHome":
true` (the export writes the directory row of a workspace named Home with
the id in `unassignedOutputsHome`). `assignments` proposes the file.

Outputs that name a deleted workspace also need the organization's reviewed
home; their revisions follow them. Conversations that name a deleted
workspace and their runs and events stay in the source stores untouched.
The report lists their conversation IDs and counts them as staying.

For an object that already owned its outputs before staging, the library's
`objectNativeEvidence` callback can supply a retained authority receipt and
a current scoped D1 read: output IDs still in source and exact output/revision
IDs in `workspace_output_index`. Only indexed rows absent from both source
and bundle are reported as `objectNativeRows`, with their IDs and evidence
reference. Other extra rows remain drift or pending source reads. Shared
objects cannot use this accounting. Import refuses to add source outputs or
revisions to an object-owned workspace, and still refuses conflicting rows
before any write. Keep these private receipts with the migration report.

Two owner decisions can be applied by name, never by default. Keep the
decision file outside source control with the migration report.

- `import --scope <org>/<ws> --merge-object-owned <org>/<ws>[,...]` merges
  the source into a named object-owned workspace instead of refusing
  (`merge.ts`). The object is never changed: a row that differs stays as the
  object has it and a row only the object holds stays. A source-only row is
  added when it is active in the source. It is left out, and printed with the
  reason, when it is archived, removed or deleted there, when its parent is
  left out, when an object row already holds its place, or when it is a
  revision at or after the current revision of an output the object owns
  (the object could no longer save that output). Add `--plan-only` to print
  the plan and write nothing; review it before the real run. A workspace that
  is not named, or is not object-owned, keeps the ordinary refusals.
- `reconcile --approved decisions.json [--merge-object-owned <org>/<ws>]`
  accounts for rows under such a decision and lists each one with the file's
  `evidenceRef`. For a merged workspace the report names the rows the object
  kept, the source rows left out and the object-only rows; a source row the
  merge would still add is a problem. For any workspace the file can list
  `objectNativeOutputIds`: outputs the object holds that neither the source
  nor the output index names. Each must be in the object and absent from the
  bundle; they and their revisions are reported as `objectNativeRows`. All
  other rows are compared as usual.

```json
{
	"evidenceRef": "<where the owner's decision is kept>",
	"workspaces": {
		"<organization id>/<workspace id>": {
			"objectNativeOutputIds": ["<output id>"]
		}
	}
}
```

When retention removed a run's events before log storage began, a reviewed
assignment can list `retainedHistory` entries with the exact `runId`,
`latestEventAt`, `reason` and durable decision `evidenceRef`. The report
lists each as a known difference. Missing events for any other run or a
changed latest-event timestamp still block import. Keep these decisions
outside source control with the capture and the Work evidence. This does
not bypass snapshot freshness, partition coverage or row/hash validation.

What stays in the shared core, with the reason, is `TABLES_THAT_STAY` in the
same file: organization memory, factory runs and their artifacts, a tedi's
own ledger, and organization Home threads (conversations with no
workspace) together with their runs and events.

## Remote protocol

The worker that hosts the workspace objects serves migration routes under
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

## Stage, reconcile, activate

Import is staging only. The first successful batch atomically preserves the
workspace's prior output authority with its rows and receipt. Directory-only,
interrupted and complete staged imports keep browser and agent output reads
and writes on shared D1. Existing object owners (including pre-protocol
imports and object-only transfer destinations) stay object owners. Import
and reconciliation never activate a workspace; neither removes D1 rows.

For a final cutover, the authorized installation operator freezes output
writes, takes a fresh snapshot, imports it and reconciles every mapped table
and revision body against that snapshot. Stage-1 additive imports can run
without a freeze, but their reports are not final cutover evidence: shared
writes after the snapshot must be included in a fresh frozen copy. The
importer adds missing rows and refuses changed existing rows; such a conflict
stops cutover and needs separately scoped staging repair before reconciliation.
Activation does not repair or overwrite a staged copy.

Read `GET` describe before reconciliation and retain its `importGeneration`
with the report. After a zero-difference reconciliation, read describe again
and require the same generation. Every newly imported batch advances that
generation; duplicate retries do not. An authorized operator then makes
one separate `POST /activate` with this body:

```json
{
	"importGeneration": 12,
	"reconciliationRef": "<durable frozen reconciliation evidence URI>"
}
```

Use the same bearer and scoped base URL as the other migration routes, or
`/admin/migration/workspaces/<org>/<workspace>/activate` at the admin gateway.
Activation rejects missing evidence and stale generations. It records the
operator's reconciliation attestation and object authority atomically;
repeating the same request returns the receipt. The reference is an operator
attestation, not automatic verification of an external report. Read authority
back and verify browser and agent behavior before lifting the freeze. The
import CLI and rehearsal never issue this operation. A product source change
or staging report grants no deployment or activation permission.

## Tests

```bash
bun test scripts/migrate-workspaces/
bun run type-check:scripts
```

The test builds the shared database from its real migration chain, with run
events split across a main store and a log partition, and runs the full
rehearsal, drift detection, rerun idempotency, the refusals, both snapshot
gates, and a scoped remote import through a stand-in gateway.
