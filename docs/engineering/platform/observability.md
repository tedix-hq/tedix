---
title: "Investigating slow Work reads"
description: "Investigating slow Work reads"
---

# Investigating slow Work reads

Use operator-authorized, read-only Workers Observability and D1 Query Insights
access for the exact installation. Keep credentials, installation identifiers,
raw query text, bind values and customer content outside this repository. The
product configuration is an example, not an installation inventory.

## Correlate a report

Open **Details** beside a failed Activity or Decisions read and copy its support reference.
API and MCP HTTP errors carry `X-Tedix-Trace-Id`; oRPC errors also carry
`json.data.traceId`. MCP tool failures carry `_meta["com.tedix/traceId"]`, including
failures transported with HTTP 200. Search Workers logs for that identifier. Generated
references are diagnostic metadata and confer no access. Input headers are
validated before they can become references.

The API emits `tedix.api.procedure` with a fixed `procedure`, `status`, `code`,
`durationMs`, correlation identifiers and D1 counters. Errors are always logged.
Successful calls are sampled at 1%, except heavy ones: 25 or more statements,
5,000 or more known rows read, or 2 s or more. Those are always logged with
`heavy: true`. Scheduled and queue invocations log `db.request` with their
trigger, statement count, D1 wall time, known rows and rows returned when they
cross similar thresholds. The counters cover the procedure's shared
request session, including authorization performed inside that procedure.
They exclude other clients, other requests and later background work.

`d1Queries` counts statements, including each statement in a batch.
`d1KnownRowsRead` and `d1KnownRowsWritten` sum D1 result metadata.
`d1QueriesWithoutMeta` makes missing costs explicit: D1 `raw()` and `first()`
return no metadata, and failed statements may not return any either. Drizzle
uses `raw()` for many reads. These are partial row-cost counters, never a total
rows-read estimate. Use Query Insights for those missing costs. Do not convert
returned result lengths into rows scanned or add a second SQL execution to
measure a read. Logs contain no SQL, parameters, request or response bodies.

## Find the expensive queries

1. Select the incident window in D1 Query Insights and the correct database.
2. Rank query shapes by **total rows read**, then total duration. Retain calls,
   total rows read/written and duration. Divide totals by calls for per-call
   costs and by window minutes for window-average rates. Averages are not peaks.
3. Match the shape privately to its query owner under `packages/db/src/queries/`.
   Inspect the actual parameter predicates, ordering and cursor bounds.
4. Run read-only `EXPLAIN QUERY PLAN` for the exact shape and representative
   parameters. Look for bounded `SEARCH ... USING INDEX` steps, and verify the
   join order. An index existing does not prove the planner uses it; a seek on
   organization alone may still read all tenant history repeatedly.
5. Exercise the real query owner through `createD1Facade` and capture its plans.
   Assert the required bounded seeks or materialization. Demonstrate that removing
   the relevant index or window makes the assertion fail. Keep sample data fictional.

## Trace an overload burst

`D1 DB is overloaded. Too many resources consumed within a 10 second window`
means D1 throttled the database after about ten seconds of CPU and memory use
inside a ten-second window. While it is throttled, every request fails, so the
routes in the error logs are victims. Find what ran just before the first error:

- The D1 queries dataset (`events.d1Queries` through the SQL API) holds one row
  per statement with time, rows read, written and returned, duration and replica
  role. Group by 10-second interval to find the heavy window, then by query. It
  is sampled, so one rare heavy statement can be missing.
- The account audit log for D1 lists every query sent over the HTTP API
  (wrangler, the Cloudflare CLI, deploy scripts) with its exact duration,
  rows read and sender. It is not sampled.
- Workers Logs: `heavy` procedure lines and `db.request` lines name the route or
  job. Count distinct requestIds, not log lines.

Rows read understates cost when a scan touches large columns stored before the
filtered or sorted ones, such as a body or metadata column.

Never run a heavy ad-hoc query against the production primary while you
investigate: one 5-second `count(*)`, `sum(length(...))` or a filter on an
unindexed column is enough to throttle production. Three bursts on
24 November 2026 were diagnostic queries. Use the datasets above, run
`EXPLAIN QUERY PLAN` before any remote read, and run unavoidable scans against
a Time Travel restore or copy.

Existing incident regressions live in
`apps/api/src/jobs/commitment-wakes.test.ts` and
`packages/db/src/queries/memory-graph.lesson-evidence.test.ts`. They run in their
workspace suites and cover the materialized polling window and exact evidence
target seek. Preserve these checks when modifying either owner.

## Count failures separately from log samples

Workers Observability calculations can group `count` by
`$workers.event.request.url` and `$workers.event.response.status`, filtered to
the selected service and status >= 400. Restrict to `/rpc/` for procedure
failures; rejected scanner probes at other paths are a different workload.
Group API and OS proxy observations separately so one request is not counted
twice. Strip tenant hosts and URL parameters before recording findings.

Record the exact time window, group limit and adaptive sampling level.
Event samples and top-N groups are not a complete census. Correlate 500s with
their underlying errors before attributing them to the known 503 incident.
A health endpoint returning 200 does not demonstrate successful authorized reads.

## Alert follow-up

A configured operator monitor should check five-minute windows, comparing
rows-read/minute against an installation-specific baseline. A starting proposal
is a warning after three windows above twice the seven-day baseline, or a 503
rate above 1% with at least 20 requests; critical at 5% for two windows. Validate
thresholds against traffic before enabling them. Emit one deduplicated Activity FYI
per incident and one recovery update; reserve a critical decision in Decisions for an
action a person actually needs to take, with evidence and an owner.

Keep credentials and installation scheduling in the operator deployment. Monitor
failure or missing telemetry must be visible independently of the overloaded D1
path. Persist window/cooldown state, avoid per-tick duplicate cards, and configure
the destination through existing schedule/skill and Activity mechanisms rather than
hardcoding a tenant into product TypeScript.

## D1 invocation analytics

The API, MCP and tedi-runtime Workers support an optional `D1_REQUESTS` binding.
When bound, every completed `withD1Ledger` invocation attempts one Analytics Engine
write, including empty ledgers and handled D1 overloads. Missing bindings are a no-op;
a failed analytics write never fails the request. An invocation terminated by
the platform before its `finally` runs cannot write a point.

`index1` is the route label with UUID, long hex and numeric path segments
replaced by `:id`, limited to 96 UTF-8 bytes. `blob1` is the normalized label,
`blob2` the Worker, `blob3` the outcome (`refused` for any observed D1 overload,
then `error` for an uncaught invocation error, otherwise `ok`), and `blob4` the
organization if already known. `double1` through `double5` are statements,
D1 wall milliseconds, known rows read, known rows written and maximum concurrent
D1 calls. SQL, bind values and query shapes are never sent. Row counts have
the same missing-metadata limitations described above.

Nested job ledgers inherit their ingress sink and emit their own labels. They
measure their own statements; do not interpret their data points as additional
HTTP requests. Durable Object reconciliation supplies its own sink because the
caller context does not cross that boundary.

Run this saved query through the Cloudflare Analytics Engine SQL API to rank
labels by total D1 wall time in each hour. Replace `public_installation_dataset`
with the private installation dataset outside this repository:

```sql
SELECT
  toStartOfHour(timestamp) AS hour,
  blob2 AS worker,
  blob1 AS label,
  SUM(_sample_interval * double2) AS d1WallMs,
  SUM(_sample_interval * double1) AS statements,
  SUM(_sample_interval) AS invocations
FROM public_installation_dataset
WHERE timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY hour, worker, label
ORDER BY hour DESC, d1WallMs DESC
LIMIT 1000
```

For the refusal acceptance check, use a fixed, completed UTC hour and matching
Worker/ingress labels, with the same explicit start and end in Workers Logs:

```sql
SELECT
  toStartOfMinute(timestamp) AS minute,
  blob2 AS worker,
  blob1 AS label,
  SUM(_sample_interval) AS refused
FROM public_installation_dataset
WHERE timestamp >= toDateTime('2026-01-01 12:00:00')
  AND timestamp < toDateTime('2026-01-01 13:00:00')
  AND blob3 = 'refused'
GROUP BY minute, worker, label
ORDER BY minute, worker, label
```

The dates above are examples. The D1 owner or LEAD records all 60 minute
comparisons against distinct Workers Logs requests containing
`temporarily unavailable`, including zero-count minutes. Use bounded log
windows to avoid the 2,000-event query cap; record sampling and truncation.
Require a difference of at most 1% in every minute (both zero counts match;
a nonzero Analytics Engine count against zero log requests does not).
Keep nested jobs and separate service-binding hops distinct from HTTP ingress
requests when selecting the comparison population.

[Analytics Engine samples writes and queries](https://developers.cloudflare.com/analytics/analytics-engine/sampling/),
so weighted sums are estimates when `_sample_interval` exceeds one. One write
attempt per ledger does not guarantee exact stored counts or the 1% live result.
Report an inconclusive comparison when sampling or log limits prevent proof.

After the first complete day, query `SUM(_sample_interval)` over that fixed
24-hour window. Report the observed volume, its sampling limits, and a 30-day
projection (`daily points * 30`) against the 10,000,000-points/month allowance.
Keep actual installation usage and the live acceptance receipts on the Work
Item; source checks alone do not establish them.
