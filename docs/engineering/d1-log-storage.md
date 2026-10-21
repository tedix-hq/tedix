# D1 log storage

The main database holds business state and authority. Detailed operational logs
need an independent capacity and retention budget. A second D1 is preferable to
Analytics Engine for these rows: the app needs exact event bodies, identifiers,
tenant filters and ordered timelines, rather than sampled metric aggregates.
Analytics Engine remains suitable for counters and latency distributions.

| Class                                         | Destination                                                 | Reason and implementation state                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successful `mcp.tool.execute` audit telemetry | Optional `LOGS_DB.audit_events`                             | Exact audit, resource, analytics and trace reads merge both stores. Security, denial, authorization and other audit actions remain in main D1. Implemented.                                  |
| Tedi and kernel runtime event streams         | Dedicated logs D1, after coordination evidence is separated | Currently also used for artifact admission, stale-run recovery, immutable cause checks and child-run completion. Moving the tables alone breaks these joins. Not implemented in this change. |
| `kernel_request_events`                       | Main D1 until a transactional outbox is introduced          | Request CAS and history append currently share one D1 batch. Cross-database batches cannot preserve that invariant. Not moved.                                                               |
| `skill_run_artifacts` bodies                  | Existing private artifact R2 bucket                         | Pointer, digest, size, path and run metadata remain in main D1. Small and large bridge bodies use R2 when available; existing inline rows remain readable.                                   |
| Workflow source snapshots                     | Main D1 `skill_workflow_sources`                            | One immutable source per skill and SHA-256; new runs reference it. Reads coalesce legacy inline source with the referenced source. Source and reference commit in one batch.                 |
| Financial ledgers and security audit          | Main D1                                                     | Canonical business and security evidence, separate from operational telemetry.                                                                                                               |

All database access stays in `@tedix/db/queries` owners. Statement builders used
in main-D1 batches remain local to that database. No distributed transaction or
silent write fallback is introduced. When the logs binding is missing, audit
writes and reads retain their existing main-D1 behavior. When it exists but is
unhealthy, errors remain visible; configuration must not silently consume main
capacity again.

## Operations integration

No deployable Worker config is changed here. This is an example addition to the
API Worker's operator-owned `wrangler.jsonc` configuration:

```jsonc
{
	"d1_databases": [
		// Keep the existing DB entry.
		{
			"binding": "LOGS_DB",
			"database_name": "example-operational-logs",
			"database_id": "<logs-database-id>",
		},
	],
}
```

Ops must provision the separate database with the `audit_events` table and its
indexes from `packages/db/src/schema/audit-events.ts`, then add that same binding
to every API environment/overlay that enables offload. Do not apply the entire
main-D1 migration chain to the logs database. The current source routes audit
writes through the API; MCP and tedi runtime do not need their own logs binding
for this phase. Apply the new workflow-source migration to main D1 before the
skill-runtime and API release. Preserve the private `SKILL_ARTIFACTS` binding in
skill-runtime and the existing API artifact reader binding to the same bucket.

The ops overlay must land first and be validated against its product config.
Any subsequent deployable product-config change needs its matching full
`Ops-Overlay` commit trailer. No installation identifiers belong in this repo.
Retain the logs binding for as long as its records need to remain visible;
removing it restores main-only behavior and does not copy logs back.

The logs database needs its own bounded retention/archive job and alerting below
its size ceiling. The existing main-D1 retention job does not sweep LOGS_DB.
Historical main-D1 audit rows stay in place for merged reads and the separately
reviewed archive/delete policy; enabling this binding does not delete anything.
No bulk snapshot backfill is required for correctness. Old inline snapshots
continue to execute the exact original source, and newly dispatched runs share
sources immediately. Artifact writes upload before committing their pointer;
failed database writes can leave orphan objects, so lifecycle cleanup must only
remove objects proven unreferenced. Immutable evidence keeps first-writer wins.

## Capacity estimate and remaining work

Using the supplied measurements, successful tool telemetry moves about
`70 × 0.95 = 66.5 MB/day` of row growth out of main D1. R2 artifact bodies can
remove up to 36 MB/day and shared workflow source up to 9 MB/day, less pointer
and new-revision costs: approximately **0.10–0.11 GB/day** before index effects.
These are projections, not live measurements. No existing space is reclaimed by
this source change. Runtime/kernel migration could remove another 34 MB/day,
but this change must not claim that saving.

The remaining runtime work needs a main-D1 authority projection plus an outbox
for cross-store event delivery, bounded merged readers (including orphan recovery,
artifact evidence, interaction continuation and Home feed joins), idempotent replay
across cutover, and deletion/retention propagation. The request CAS must still
atomically publish durable intent. It cannot be replaced by two independent
writes merely because the second binding is present.

[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) document the
10 GB database ceiling and 100-parameter statement limit. Keep both databases'
queries bounded and preserve D1 batch semantics.
