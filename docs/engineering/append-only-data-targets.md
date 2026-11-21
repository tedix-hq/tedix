# Where high-volume append-only data should live

Decision note, 20 November 2026. This note decides where append-only history
lives long term: audit events, agent attributions, AI call costs, gateway
change records, cron runs, kernel request events and Work events. History
is kept, not deleted; storage is cheap. Two goals matter:

- it stays queryable for the product and for incident review, and
- it can be exported as evidence for partners and audits, with EU data
  residency.

The rotating logs databases plus the EU archive are the interim history
tier; the target is one log store per organization
([organization log store](organization-log-store.md), Work c5642d65).

Fitting the main database under 10 GB is not the goal; moving older rows
out of it keeps it fast. The note builds on
[D1 log storage](d1-log-storage.md), which describes the current second
database (`LOGS_DB`) and the R2 archive. It is also input to the choice
between Postgres and D1 for the main database.

## Decision

1. **Personal or tenant data stays in EU D1 plus the EU R2 archive for
   now.** Basin Catalog (Iceberg tables on R2) does not support R2 buckets
   in a non-default jurisdiction
   ([limitations](https://developers.cloudflare.com/basin-catalog/manage-catalogs/#limitations)),
   so it cannot hold EU-only data yet. Until it can, history for these
   tables keeps going to `LOGS_DB` (EU D1) and to the R2 archive in the EU
   bucket. Main D1 keeps only a short window. No history class is deleted:
   tables that have a delete today switch to the same copy-verify-move.
2. **Analytics Engine only as an extra view**, never as the store of
   record. It keeps data three months and samples at high volume, so it
   suits dashboards over platform counters, not history.
3. **Workers Logs, Traces and K2 are not stores of record.** Use Logs and
   Traces for debugging, with the account's Customer Metadata Boundary set
   to `eu`.
4. Look at Iceberg again when Basin Catalog supports EU jurisdiction
   buckets. It would then replace the `LOGS_DB` rotation as the history
   tier.

## Primitives

| Primitive                                                                                                                                                                                               | Good for                                                            | Retention                                                                                                | Query path                                                                           | Cost (Workers Paid)                                                                                                                                                                                                                                                                                                         | EU residency                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Traces](https://developers.cloudflare.com/workers/observability/traces/)                                | Debugging requests and errors                                       | 7 days; 30/90/365 days are planned ([pricing](https://developers.cloudflare.com/observability/pricing/)) | Dashboard Query Builder and API. No joins with app data                              | 20M log events included, then $0.60 per million. From 1 Dec 2026: $0.25/GB ingested and $0.10/GB-month stored beyond the included allowance                                                                                                                                                                                 | [Customer Metadata Boundary](https://developers.cloudflare.com/data-localization/metadata-boundary/get-started/) `eu` keeps customer logs in the EU |
| Export: [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/) / [OTel export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) | A permanent copy of logs in R2 or another tool                      | Whatever the destination keeps                                                                           | The destination's tools                                                              | 10M requests included, then $0.05 per million ([pricing](https://developers.cloudflare.com/logs/logpush/pricing/#workers-logpush))                                                                                                                                                                                          | Follows the destination bucket's jurisdiction                                                                                                       |
| [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)                                                                                                                       | High-cardinality counters and timings: counts, sums, latency by key | 3 months ([limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/))                | SQL API; results are sampled at high volume; 20 blobs, 20 doubles, 1 index per point | 10M points written per month included, then $0.25 per million; 1M queries included, then $1 per million ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/))                                                                                                                                  | No jurisdiction setting in the docs. Only for data without personal or tenant content                                                               |
| [Pipelines](https://developers.cloudflare.com/basin-pipelines/) → R2 as Iceberg ([Basin Catalog](https://developers.cloudflare.com/basin-catalog/))                                                     | Exact rows kept for years, queried with SQL                         | You choose (snapshot expiry)                                                                             | [Basin SQL](https://developers.cloudflare.com/basin-sql/) or any Iceberg engine      | Writing to the stream is free; the sink costs $0.03/GB as JSON or $0.06/GB as Parquet/Iceberg ([pricing](https://developers.cloudflare.com/basin-pipelines/platform/pricing/)). R2 storage is $0.015/GB-month. Basin SQL is $2.50 per TB scanned ([pricing](https://developers.cloudflare.com/basin-sql/platform/pricing/)) | **Not today**: the catalog does not support jurisdiction buckets. A JSON or Parquet sink into an EU bucket is untested                              |
| [K2](https://developers.cloudflare.com/k2/)                                                                                                                                                             | A durable log read by several independent consumers                 | Up to 30 days                                                                                            | Consumer API                                                                         | Public beta; 10 GB per account during the beta                                                                                                                                                                                                                                                                              | Unverified                                                                                                                                          |
| [R2](https://developers.cloudflare.com/r2/) (current archive)                                                                                                                                           | Permanent, verified copy of moved rows (gzip NDJSON)                | Unlimited                                                                                                | Download objects; no SQL                                                             | $0.015/GB-month ([pricing](https://developers.cloudflare.com/r2/pricing/))                                                                                                                                                                                                                                                  | [EU jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/#jurisdictional-restrictions) buckets                                |
| Second EU D1 (`LOGS_DB`, current)                                                                                                                                                                       | Exact rows with the same SQL as main, read by the merged readers    | Until rotated; rotate at 6 GB                                                                            | Same queries as main, merged by `@tedix/db/utils/log-store`                          | D1 storage and reads                                                                                                                                                                                                                                                                                                        | EU jurisdiction database                                                                                                                            |

## One target per table

Live counts from 20 Nov 2026, 17:15 UTC.

| Table                         | Rows in main | Target                                                                                                                                   | Why                                                                                                                                                      |
| ----------------------------- | -----------: | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_events`                |        1.72M | Keep the current split: MCP telemetry goes to `LOGS_DB`; everything else stays in main for 90 days, then moves                           | Tenant audit search needs exact rows and EU residency. Iceberg is blocked (see above). Next step: lower the 90-day main floor for telemetry actions only |
| `external_agent_attributions` |        0.52M | Main for 7 days, then `LOGS_DB` + R2 (done 20 Nov)                                                                                       | Exact provenance rows; the replay check reads `LOGS_DB`                                                                                                  |
| `tedi_call_costs`             |        0.93M | Main for 90 days, then `LOGS_DB` + R2 (done 20 Nov). Add an Analytics Engine stream of platform cost totals for dashboards               | Billing needs exact, complete rows. Aggregates do not need personal data                                                                                 |
| `gateway_change_records`      |        0.07M | Main for 90 days, then `LOGS_DB` + R2 instead of today's 90-day delete. Each checkpoint also gets a verified evidence bundle in R2 first | Change evidence must outlive 90 days                                                                                                                     |
| `platform_cron_executions`    |        0.82M | Main for 90 days, then `LOGS_DB` + R2 instead of today's 90-day delete. Optional Analytics Engine view for run dashboards                | Platform-only, no tenant data. Readers need recent receipts; history is evidence that jobs ran                                                           |
| `kernel_request_events`       |        0.43M | Main while the request is open, then `LOGS_DB` + R2                                                                                      | Today not moved, because the request update and the history append share one batch. Moving finished requests needs a pin like the artifact one           |
| `tedi_runtime_events`         |        0.16M | Keep as is: 14 days in main, then `LOGS_DB` + R2                                                                                         | Already moving                                                                                                                                           |
| `work_events`                 |        0.13M | Stay in main                                                                                                                             | Work history is business state. Heartbeat and read events stopped being recorded (2cc7c06dc)                                                             |

## Order

1. `platform_cron_executions` and `gateway_change_records`: replace the
   90-day deletes with `move_to_logs_db` (Work 7f5f9280, Work 2661a2c4).
   These are the only history classes still deleted.
2. `kernel_request_events`: move finished requests to `LOGS_DB` (Work 7f310f9e).
3. `audit_events`: a shorter main window for MCP telemetry actions
   (Work 1398edba).
4. `tedi_call_costs`: an Analytics Engine view of platform cost totals for
   dashboards (Work acd2ab00). Optional.
5. Check whether a Pipelines JSON/Parquet sink can write to an EU
   jurisdiction bucket, and whether Basin Catalog supports one yet. If both
   work, plan Iceberg as the history tier that replaces `LOGS_DB` rotation
   (Work de5ac2d1).

Note: on 20 Nov, attributions and call costs together added about
20 MB/day to main. They are not what drives the measured ~28 MB/h growth.

## Evidence and export

What exists today:

- Every row that leaves main is first copied to `LOGS_DB` (EU D1) and to the
  private EU R2 bucket as gzip NDJSON under
  `d1-archive/v1/<table>/<organization>/<day>/`. Rows are compared column
  by column before the main row is deleted. Platform call costs use the
  owner `_platform`. Nothing deletes these objects.
- Each organization's audit trail is exported daily to R2 under
  `audit-exports/v1/<org>/<day>/<hour>.jsonl.gz`. **That export deletes
  objects older than 13 months** (`apps/api/src/services/audit-daily-export.ts`).
  Under "keep history" this deletion should go (Work 41949610). The full rows
  are still in the `d1-archive` copy once they leave main.

- Every gateway change record checkpoint gets an evidence bundle in the EU
  R2 bucket under `change-record-evidence/v1/<org>/<last sequence>-<checkpoint>.json`
  within minutes of sealing: the checkpoint and its records, checked with
  `verifyChain` (and the signature, when signed) before writing. A researcher
  verifies one bundle, or several consecutive ones, offline with
  `verifyChain`. Retention removes a checkpoint's records from main only
  after its bundle is stored (`evidence_bundle_key`).

Organization evidence packs:

- `bun scripts/db/history-export.ts` collects a time range across main,
  `LOGS_DB`, supplied `LOGS_DB_<n>` partitions and the R2 archive into the EU
  bucket. Its manifest records each file's table, row count, observed time
  bounds and SHA-256, with source keys and input hashes for archived rows.
- A standalone Python verifier checks the pack offline against a trusted
  manifest digest. See [history export](history-export.md) for installation
  targets, scope, collection consistency and verification limits. Production
  export acceptance remains a separate operator check (Work 9967af3a).

## For the Postgres or D1 decision

- **Volume**: these history tables are the bulk of row growth, and none of
  them needs to stay in the main database past its keep window. With
  history in `LOGS_DB` + R2, the main database holds business state and a
  bounded window, so its size is no longer driven by history.
- **D1 path**: history stays in a chain of EU D1 logs databases, rotated at
  6 GB, plus R2. Reads merge partitions in application code. Every
  rotation is an ops step (new database, binding, migrations).
- **Postgres path**: one database can hold history with partitioned tables,
  and the size limit goes away. EU residency then depends on where the
  Postgres host runs; Cloudflare's part (Hyperdrive) only connects to it.
  The R2 archive stays either way.
- **Iceberg on R2** would be the Cloudflare-native long-term SQL store for
  history, but it cannot hold EU-only data today (see Decision). Re-check
  under Work de5ac2d1 before choosing.
