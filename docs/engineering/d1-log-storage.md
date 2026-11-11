# D1 log storage

The main database holds business state and authority. The append-only log
classes get their own capacity: a second D1 (`LOGS_DB`) for the rows, R2 for
large bodies and for a permanent copy of every row that leaves the main
database. A second D1 is preferable to Analytics Engine for these rows: the
app needs exact event bodies, identifiers, tenant filters and ordered
timelines, not sampled aggregates.

The `LOGS_DB` binding is the only switch. A Worker without it behaves exactly
as before: writes stay in the main database, reads see the main database. No
feature flag, no configuration row.

## Where each class goes

| Class                                           | New rows                                                                    | Rows past the keep window                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Known MCP execution telemetry                   | `LOGS_DB.audit_events` (`queries/audit.ts`), metadata over 4 KiB in R2      | `move_to_logs_db`                                                     |
| Every other audit action                        | Main D1, including rows composed into a main-database batch                 | `move_to_logs_db`                                                     |
| `tedi_runtime_events`                           | Main D1                                                                     | `move_to_logs_db`                                                     |
| `kernel_runtime_events`                         | Main D1                                                                     | `move_to_logs_db`                                                     |
| `kernel_request_events`                         | Main D1                                                                     | Not moved: request CAS and history append share one batch             |
| `skill_run_artifacts`                           | Pointer row in main D1; body in the private artifact bucket when over 4 KiB | `move_to_logs_db`                                                     |
| `external_agent_attributions`                   | Main D1 (credential-checked insert, unique key)                             | `move_to_logs_db`, 30-day floor, unreviewed `mcp_execution` rows only |
| Workflow source snapshots                       | Main D1 `skill_workflow_sources`, one row per skill and SHA-256             | n/a                                                                   |
| `tedi_call_costs`                               | Main D1                                                                     | `move_to_logs_db`, 400-day floor; settled or quarantined rows only    |
| Other financial ledgers, security audit, grants | Main D1                                                                     | Not moved by these policies                                           |

The execution telemetry allowlist covers `mcp.tool.execute`, `mcp.tool.error`,
`mcp.code.execute`, `mcp.code.error`, `mcp.prompt.execute`, `mcp.prompt.error`,
`mcp.resource.read` and `mcp.resource.error`. Access denials, payment events,
unknown actions and audit inserts composed into main-database batches stay
in main D1. New telemetry actions require an explicit review before redirecting.

Why runtime and kernel event rows are not redirected at write time: twenty
query modules read them with joins and correlated checks that need the row in
the same database as its parents. Examples: the Home finished-run feed joins
`kernel_runtime_runs` with `tedi_runtime_events`; cause-bound kernel events
are `INSERT ... SELECT` from their cause row; artifact contribution receipts
join the producer event by id and payload; interaction review checks the
`tool.completed` evidence row; conversation purge deletes by conversation.
Keeping new rows in the main database for the keep window keeps every one of
those correct. The retention move bounds what the main database holds to the
keep window, and the merged readers keep older rows visible.

## Reads

Readers that can see moved rows run the same statement against both stores
(`@tedix/db/utils/log-store`): the same tenant scope, filters and cursor in
each store, dedupe by id (a row exists in both for a moment during a move),
then order, offset and limit over the merged set. Offset is never applied per
store. Covered: audit search, audit by resource, analytics audit activity and
freshness, Home run audit references, tedi observability, the runtime event
lists (`listTediRuntimeEvents`, `listKernelRuntimeEvents`,
`listTediRuntimeEventsForRouter`, transcript rows), single-event reads by id,
run artifact reads, and the organization cost ledger (`listOrgCallCostLedger`).
Cost pages are filtered and ordered in each partition, then hydrated in bounded
pages against main D1 for tedi names and reviewed provider estimates. Authority
is never copied to the logs database. Joins and compare-and-set reads stay on the main
database by design; they only ever need rows inside the keep window.

## Retention move (`move_to_logs_db`)

`d1_retention_policies` drives the job (`apps/api/src/jobs/d1-retention.ts`,
engine in `apps/api/src/services/d1-retention-archive.ts`), which runs every
15 minutes with a 20 s time budget per run. Initial policies ship in
`dry_run`; explicit activation migrations enable the attribution and call-cost
moves after the logs schema and rotation prerequisites are installed. The `move_to_logs_db` mode, oldest rows first and capped per run by
`max_rows_per_run` (the per-run budget an operator tunes on the row), works in
pages of 500 rows read with one statement:

1. copies the page into `LOGS_DB` with `INSERT OR IGNORE`. The rows travel as
   one JSON array parameter per statement (about 256 KB each, expanded with
   `json_each`), so a statement stays far under D1's 100 bound-parameter cap;
   a row larger than that is bound column by column on its own;
2. reads the ids back in the same `LOGS_DB` batch, after the inserts, and
   compares every column with the rows read from the main database; a row
   with no logs copy stops the run before anything is deleted. A row whose
   logs id already holds a different version is a conflict (`conflictedRows`,
   `conflicts` in the report): the logs copy is never rewritten, the source
   version still reaches R2 in step 3, and only then is the main row
   deleted — the runtime event ledgers are mutable
   (`updateKernelRuntimeEventMetadata`, `updateTediRuntimeEventPayload`) and
   their deterministic ids can be re-inserted, so a divergence is an earlier
   copy of the same id, not a broken copy;
3. writes the page as gzip NDJSON to the private tedi bucket under
   `d1-archive/v1/<table>/<day>/<first>-<last>.ndjson.gz` and confirms the
   object R2 returns for the write (same key, same size);
4. only then deletes exactly those rowids from the main database in one
   statement (rowids as one JSON parameter), rechecking the cutoff, with
   0.5 s, 1 s and 2 s back-off when D1 reports `overloaded`.

The next page is read while the current one goes through steps 1 to 4, so a
page costs about three round trips (logs batch, R2 write, delete). The
backlog estimate runs after the moves. Each report carries `timings`
(`readMs`, `copyMs`, `archiveMs`, `deleteMs`, `estimateMs`, `pages`) so a slow
step shows up in `last_report`.

A policy row whose `keep_days` sits below the table's floor (the shipped
`audit_events` seed says 14 days against a 90-day floor) runs at the floor
and reports both values (`keepDays`, `keepDaysRow`) instead of being
refused. The nightly `retention-cleanup` cron no longer deletes
`audit_events`, `tedi_runtime_events` or `kernel_runtime_events`: these
rows leave the main database only through this engine, after a verified
copy exists.

Separately, each organization keeps its own copy of its audit trail: the
nightly `retention-cleanup` tick writes every finished UTC day to
`R2_BUCKET` as gzip JSON Lines, one object per hour
(`audit-exports/v1/<org>/<YYYY-MM-DD>/<HH>.jsonl.gz`, the `audit.export`
event shape), retries the last seven days, and deletes objects older than
13 months (`apps/api/src/services/audit-daily-export.ts`).

A run that stops anywhere leaves the main rows in place; the next tick repeats
steps 1 to 4 for the same rows (the copy is a no-op for rows already there,
the archive key is deterministic). Without the `LOGS_DB` binding the policy
reports `logs_db_missing` and changes nothing; a table the logs database does
not hold reports `logs_db_unsupported`.

Switching a table on is an operator change to its policy row, for example:

```sql
UPDATE d1_retention_policies
SET mode = 'move_to_logs_db', updated_at = CURRENT_TIMESTAMP
WHERE table_name = 'audit_events';
```

Read the first `last_report` after the switch (`movedRows`, `deletedRows`,
`stoppedBy`, `error`) before switching the next table.

## Size alert

The same tick measures both databases through D1's own
`meta.size_after` (`@tedix/db/queries/d1-size`) and pages the ops channel
(`ops_alert_state` plus `sendOpsAlert`, the platform-health path) when the
main database reaches 9 GB or the logs database reaches 6 GB. The logs alert
is the rotation trigger: create the next logs database, apply the logs
schema, rebind `LOGS_DB`, and keep the old database bound as `LOGS_DB_<n>`
so merged readers still query it. R2 is the permanent archive, not the SQL
read path. Plan rotation before the alert threshold when enabling a backlog.
Both conditions re-page when the size crosses the next 0.25 GB and page once
more on recovery. The cron receipt carries `d1MainSizeMb` and `d1LogsSizeMb`.

## Operations

The `LOGS_DB` binding belongs in the **api** Worker's private overlay and
matching product config only: audit writes from MCP, the tedi runtime and the CMS all go through
`audit/createEvent` on the API, the retention job runs on the API cron, and
every merged reader is an API query. Other Workers keep reading the main
database, which holds every row inside the keep window.

```jsonc
// Example addition to the api Worker's d1_databases (placeholders only).
{
	"binding": "LOGS_DB",
	"database_name": "public-installation-logs",
	"database_id": "00000000-0000-0000-0000-000000000000",
}
```

Steps, in order:

1. Create the logs database in the EU jurisdiction:
   `wrangler d1 create <logs-database-name> --jurisdiction=eu`.
2. Apply the logs schema from `packages/db/logs-db/migrations` (append-only,
   ledger table `tedix_logs_migrations`; `packages/db/logs-db/wrangler.jsonc`
   is the example config):
   `wrangler d1 migrations apply <logs-database-name> --remote -c <overlay config>`.
   Do not apply the main migration chain to the logs database.
3. Apply the main-database migration `shared_workflow_sources` through the
   normal release.
4. Add the `LOGS_DB` binding to the api overlay and release. From that deploy
   on, new allowlisted MCP telemetry rows land in the logs database and the merged
   readers are active.
5. Watch one `d1-retention` receipt (`d1MainSizeMb`, `d1LogsSizeMb`,
   each table's `dry_run` report), then switch tables to `move_to_logs_db`
   one at a time with the `UPDATE` above.

Removing the binding restores main-only behaviour; it does not copy rows
back, so rows already moved stay in the logs database and in R2.

## Rotation before retention activation

The API discovers `LOGS_DB` and numbered historical bindings dynamically.
Numbered bindings are read-only in application code; only `LOGS_DB` receives
new telemetry and retention copies. Before enabling a backlog that could take
the writer past 6 GB:

1. Create the next EU logs database and apply **all** logs migrations, including
   `0010_tedi_call_costs.sql`, with the private overlay's logs migration ledger.
   Apply the same migrations to every historical database that merged readers
   can visit. Never apply the main migration chain to logs.
2. Keep existing `log_partition.from_ts` bounds broad enough for historical
   backfill, not merely the day the partition was created. An empty directory
   is conservative and reads all dates. A new active partition must also cover
   dates older than its creation time, because retention copies old rows.
3. In the private API overlay, bind the previous writer under the next unused
   `LOGS_DB_<n>` name and point `LOGS_DB` to the new database in the same release.
   Preserve all earlier numbered bindings. Add the corresponding placeholder
   binding in `apps/api/wrangler.jsonc` only after validating and landing the
   matching private ops overlay. The product commit needs
   `Ops-Overlay: <full ops commit SHA> apps/api/wrangler.jsonc`.
4. Drain invocations of the previous deployment before sealing the old
   partition. If its directory is populated, preserve its lower bound and set
   an inclusive upper bound covering every stored event. Leave an empty
   directory empty when exact bounds are unknown; a wrong bound hides rows.
5. Release the activation migration only after the logs migrations and new
   bindings are installed. Read the engine's own `d1.retention.run` and
   `last_report` records for moved/deleted counts and errors. Production row
   counts and historical read acceptance are separate lead-session checks.

## Call-cost reader boundary

The 400-day main floor is retained because billing still joins source calls to
main-only authority in a single statement or batch:

- `platform-job-storage.ts` scans insertion-order settlement watermarks and
  joins charges, quarantines and provider usage; moving pending rows would
  silently remove work from those queues.
- `billing/health.ts` joins reservations, charges and quarantines for settlement
  and provider attribution health. `billing/provider-cost-evidence.ts` verifies
  source snapshots and approval/admission authority in the same database.
- `billing/cost-rollups.ts` rebuilds a closed day's aggregates with a main D1
  delete/insert-select batch. `billing/model-fit-report.ts` joins provider
  execution, Work and admission records.
- `tedi-usage.ts` serves 30-day freshness, admission budgets, anomaly windows
  and per-tedi totals/history; `work-agent-sessions.ts` joins costs to recent
  lane sources. `usage-ledger.ts` supports arbitrary billing windows and now
  merges archived partitions. `billing/provider-usage.ts` uses its own provider
  usage ledger; its mention of call costs is explanatory. `tedis.ts` and
  `catalog/change-tracking.ts` mention the table only in comments.

The engine additionally pins successful calls without a charge, provider-usage
receipt or quarantine, all reviewed source calls, and calls without an
organization (the archive requires tenant ownership). These pins are checked
before copying and again when deleting. The 400-day floor is not a promise
that an unresolved call is safe to move on day 401. A shorter main window needs
partition-aware settlement and historical batch rebuilds first; retaining this
floor may produce no immediate call-cost reduction if all source rows are newer.

## Capacity

With the supplied measurements (audit 70 MB/day, 95 % `mcp.tool.execute`;
tedi runtime 16 MB/day; kernel 18 MB/day; artifacts 36 MB/day; workflow source
about 9 MB/day): the write redirect removes about 66 MB/day of audit growth,
R2 bodies and shared workflow source up to 45 MB/day, so the main database
grows by roughly 0.03 to 0.05 GB/day instead of 0.15 to 0.2 GB/day from these
classes. Once every table is in `move_to_logs_db` with a 14-day window, the
main database holds a bounded 14 days of runtime, kernel and artifact rows
(about 0.5 GB at today's rates) and its remaining growth is business data.
These are projections; the retention receipt reports the measured sizes.
