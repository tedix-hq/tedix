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

| Class                                     | New rows                                                                    | Rows past the keep window                                 |
| ----------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `mcp.tool.execute` audit telemetry        | `LOGS_DB.audit_events` (`queries/audit.ts`), metadata over 4 KiB in R2      | `move_to_logs_db`                                         |
| Every other audit action                  | Main D1, including rows composed into a main-database batch                 | `move_to_logs_db`                                         |
| `tedi_runtime_events`                     | Main D1                                                                     | `move_to_logs_db`                                         |
| `kernel_runtime_events`                   | Main D1                                                                     | `move_to_logs_db`                                         |
| `kernel_request_events`                   | Main D1                                                                     | Not moved: request CAS and history append share one batch |
| `skill_run_artifacts`                     | Pointer row in main D1; body in the private artifact bucket when over 4 KiB | `move_to_logs_db`                                         |
| Workflow source snapshots                 | Main D1 `skill_workflow_sources`, one row per skill and SHA-256             | n/a                                                       |
| Financial ledgers, security audit, grants | Main D1                                                                     | `tedi_call_costs` keeps its archive-only policy           |

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
and run artifact reads. Joins and compare-and-set reads stay on the main
database by design; they only ever need rows inside the keep window.

## Retention move (`move_to_logs_db`)

`d1_retention_policies` drives the hourly job (`apps/api/src/jobs/d1-retention.ts`,
engine in `apps/api/src/services/d1-retention-archive.ts`). Every policy row
ships in `dry_run`. The `move_to_logs_db` mode, oldest rows first and capped
per run by `max_rows_per_run`:

1. copies a chunk of at most 500 rows into `LOGS_DB` with `INSERT OR IGNORE`,
   at most `floor(100 / columns)` rows per statement (D1's bound-parameter cap);
2. reads the ids back from `LOGS_DB` and compares every column with the source
   rows; any missing or different row stops the run before anything is deleted;
3. writes the chunk as gzip NDJSON to the private tedi bucket under
   `d1-archive/v1/<table>/<day>/<first>-<last>.ndjson.gz` and confirms it with
   `head()`;
4. only then deletes exactly those rowids from the main database, rechecking
   the cutoff in each statement, with 0.5 s, 1 s and 2 s back-off when D1
   reports `overloaded`.

A policy row whose `keep_days` sits below the table's floor (the shipped
`audit_events` seed says 14 days against a 30-day floor) runs at the floor
and reports both values (`keepDays`, `keepDaysRow`) instead of being
refused. The nightly `retention-cleanup` cron no longer deletes
`audit_events`, `tedi_runtime_events` or `kernel_runtime_events`: these
rows leave the main database only through this engine, after a verified
copy exists.

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

The same hourly tick measures both databases through D1's own
`meta.size_after` (`@tedix/db/queries/d1-size`) and pages the ops channel
(`ops_alert_state` plus `sendOpsAlert`, the platform-health path) when the
main database reaches 9 GB or the logs database reaches 6 GB. The logs alert
is the rotation trigger: create the next logs database, apply the logs
schema, rebind `LOGS_DB`, and the old one stays readable through its R2 copy.
Both conditions re-page when the size crosses the next 0.25 GB and page once
more on recovery. The cron receipt carries `d1MainSizeMb` and `d1LogsSizeMb`.

## Operations

No deployable Worker config in this repository changes. The `LOGS_DB`
binding is added in the operator's private overlay for the **api** Worker
only: audit writes from MCP, the tedi runtime and the CMS all go through
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
   on, new `mcp.tool.execute` rows land in the logs database and the merged
   readers are active.
5. Watch one hourly `d1-retention` receipt (`d1MainSizeMb`, `d1LogsSizeMb`,
   each table's `dry_run` report), then switch tables to `move_to_logs_db`
   one at a time with the `UPDATE` above.

Removing the binding restores main-only behaviour; it does not copy rows
back, so rows already moved stay in the logs database and in R2.

## Capacity

With the supplied measurements (audit 70 MB/day, 95 % `mcp.tool.execute`;
tedi runtime 16 MB/day; kernel 18 MB/day; artifacts 36 MB/day; workflow source
about 9 MB/day): the write redirect removes about 66 MB/day of audit growth,
R2 bodies and shared workflow source up to 45 MB/day, so the main database
grows by roughly 0.03 to 0.05 GB/day instead of 0.15 to 0.2 GB/day from these
classes. Once every table is in `move_to_logs_db` with a 14-day window, the
main database holds a bounded 14 days of runtime, kernel and artifact rows
(about 0.5 GB at today's rates) and its remaining growth is business data.
These are projections; the hourly receipt reports the measured sizes.
