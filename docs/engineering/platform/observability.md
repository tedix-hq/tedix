# Investigating slow Work reads

Use operator-authorized, read-only Workers Observability and D1 Query Insights
access for the exact installation. Keep credentials, installation identifiers,
raw query text, bind values and customer content outside this repository. The
product configuration is an example, not an installation inventory.

## Correlate a report

Open **Details** beside a failed Feed or Deck read and copy its support reference.
API and MCP HTTP errors carry `X-Tedix-Trace-Id`; oRPC errors also carry
`json.data.traceId`. MCP tool failures carry `_meta["com.tedix/traceId"]`, including
failures transported with HTTP 200. Search Workers logs for that identifier. Generated
references are diagnostic metadata and confer no access. Input headers are
validated before they can become references.

The API emits `tedix.api.procedure` with a fixed `procedure`, `status`, `code`,
`durationMs`, correlation identifiers and D1 counters. Errors are always logged;
successful calls are sampled at 1%. The counters cover the procedure's shared
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
thresholds against traffic before enabling them. Emit one deduplicated Feed FYI
per incident and one recovery update; reserve a critical Deck decision for an
action a person actually needs to take, with evidence and an owner.

Keep credentials and installation scheduling in the operator deployment. Monitor
failure or missing telemetry must be visible independently of the overloaded D1
path. Persist window/cooldown state, avoid per-tick duplicate cards, and configure
the destination through existing schedule/skill and Feed mechanisms rather than
hardcoding a tenant into product TypeScript.
