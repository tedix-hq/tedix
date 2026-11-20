# Shared core database: stay on D1, split per organization, or Postgres

Decision note, 20 November 2026 (Work 85ebc58a, follows 519cc0e4,
a515d1f2 and ff12969f). It answers one question: where should the shared
core live — organizations, members and access, Work, billing and credits,
tools and catalog, skills, shares, organization memory and tedi memory?

Per-workspace data (files, workspace chat, workspace memory, tedi artifacts)
already lives in per-workspace Durable Object SQLite stores
(`apps/workspace-do`). Append-only history is moving out of main D1
([where history lives](append-only-data-targets.md)), towards one log store per
organization (Work c5642d65). Neither is in scope: the core is what remains in
main once history has left.
Staying under 10 GB is not a goal in itself; history is kept, not deleted.

## Recommendation

**Stay on D1 for the core, with history moved out, and decide again on
4 December 2026 from two weeks of daily snapshots.** Do not start a Postgres
port now, and do not split the core per organization.

Why, in one paragraph: the core is about a quarter (2.3 GB) of main D1's
9.7 GB; history is two thirds (6.4 GB) and is already leaving. The
errors people see ("temporarily unavailable", D1 7429) come from a handful
of expensive statements that hold D1's single writer thread, not from the
number of tenants or from missing transactions. One statement alone read
a sixth of all rows yesterday, and four run for a second or more each. Fixing those is days of work; a
Postgres port is ~2,100 dialect-specific SQL pieces plus a cutover, and the
one benchmark we ran missed every latency target. Only one class of
correctness problem needs real transactions, and the three cases found can
each be fixed on D1 with one guarded statement.

The decision flips to Postgres if the triggers below fire after the
history move and the statement fixes have landed.

## Today's baseline (20 Nov 2026)

Snapshot window: 19 Nov 18:00 to 20 Nov 18:00 UTC. Method: `scripts/db/core-capacity-snapshot.ts`
(read-only). Rows are exact below 250,000 and the rowid span above that
(exact for append-only tables, an upper bound where rows were deleted).
Bytes are estimated from the newest 200 rows of every table plus index key
widths, then scaled to the database's real file size; treat them as shares,
not exact sizes. Load comes from D1 query insights (the top 1,000
statements by reads, by duration and by executions, which cover
57% of rows read).

| Group                        | Tables |  Rows | Share of the 9,714 MB file | Rows read / day | Rows written / day |              D1 time / day |
| ---------------------------- | -----: | ----: | -------------------------: | --------------: | -----------------: | -------------------------: |
| Core business                |    273 | 2.28M |             2,337 MB (24%) |            391M |              1.79M |                    4,787 s |
| Organization and tedi memory |     29 | 0.36M |                514 MB (5%) |            103M |              0.31M |                    1,918 s |
| Append-only history          |     39 | 5.68M |             6,357 MB (65%) |            739M |              1.84M |                    1,858 s |
| App catalog cache            |     14 | 0.49M |                507 MB (5%) |             64M |              0.22M |                      491 s |
| All (insights total)         |    355 | 8.82M |                   9,714 MB |          2,312M |              5.02M | ≥ 9,551 s (11% of the day) |

D1 time is the sum over the statements insights lists, so the real total
is higher. The four largest single tables are all history:
`os_gadget_executions` (~1.8 GB, 25k rows of large bodies), `audit_events`
(1.2 GB), `external_agent_attributions` (1.0 GB) and `tedi_call_costs`
(0.9 GB). The largest core tables are `billing_usage_reservations` and
`billing_usage_charges` (~0.3 GB each).

Errors in Worker logs over the same 24 h: 15,252 "Database temporarily unavailable" events (tedix-api
12,763, tedix-mcp 2,363), 1,883 "D1 DB is overloaded" events (1,449 of them
from the CMS runtime's own database) and 17,229 `D1_ERROR` events. These
count log lines, not failed requests: one failure can log more than once.

Biggest statements by D1 time (24 h):

| Statement (main table)                                           |    Runs | D1 time | Per run | Rows read |
| ---------------------------------------------------------------- | ------: | ------: | ------: | --------: |
| Full-row select of `tedi_rationale_records`                      |     302 |   722 s |   2.4 s |      7.1M |
| `organizations` by id                                            | 448,422 |   459 s |    1 ms |     0.45M |
| `work_approval_executions` join                                  | 739,651 |   431 s |  0.6 ms |      2.2M |
| `learning_interaction_events` newest first (largest of 3 shapes) |     350 |   409 s |   1.2 s |     16.4M |
| Full-row select of `memory_facts`                                |     308 |   350 s |   1.1 s |      8.2M |
| FTS recall joined to `memory_facts`                              |   4,176 |   327 s |   78 ms |      3.3M |
| Seal update of `gateway_change_records`                          |  69,514 |   324 s |    5 ms |      367M |
| `decision_exposures` / `tedi_approval_requests` join             |   1,177 |   230 s |   0.2 s |     17.4M |

A statement that runs for a second holds D1's only thread for that second;
every other request queues behind it, and the queue overflow is what users
see as "temporarily unavailable". The seal update was fixed on 19 Nov
(8f2a540e5, deployed 20 Nov) and alone read 16% of all rows. The other
statements are in Work d25d03ba.

Daily snapshots are appended to the Engineering workspace sheet
**Main D1 daily capacity snapshots** (one row per group per day) by a
launchd job on the operator Mac at 05:30 CET, until 4 December 2026.

## Flows that need more than `db.batch()`

A `db.batch()` is atomic, but a statement cannot branch on an earlier
statement's result in application code. The question is which flows read,
decide in code, then write, so that a concurrent writer can slip in between.

Most money and Work paths already fold the decision into the write: one
guarded `INSERT … SELECT` or `UPDATE … WHERE`, `changes()` chaining, a
trigger that aborts, a version compare-and-set, or a unique index. They are
safe on D1:

| Flow                             | Code                                                    | How it stays correct on D1                                                                                           |
| -------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Credit reservation               | `packages/db/src/queries/billing/reservations.ts`       | One `INSERT … SELECT` with the pool check and an idempotency key                                                     |
| AI usage settlement              | `billing/settlement.ts`                                 | Guarded insert, then period update `WHERE changes()=1`, then reservation update `WHERE EXISTS(charge)`, in one batch |
| Code-run debit                   | `billing/credit-pool.ts`                                | Admission predicate in the batch; unique source index stops a double debit                                           |
| Entitlement override             | `billing/credit-pool.ts`                                | `entitlementVersion` compare-and-set                                                                                 |
| Work admission                   | `work-items/admissions.ts`                              | Budget and resource caps enforced by triggers that abort the batch                                                   |
| Attempt start, heartbeat, settle | `work-items/attempts.ts`                                | `INSERT … SELECT` re-checks version and the attempt cap; unique active slot; fenced compare-and-set                  |
| Work approvals, interactions     | `work-items/approvals.ts`, `work-items/interactions.ts` | Version compare-and-set                                                                                              |
| Gateway change-record chain      | `gateway-change-records.ts`                             | "No later row sealed" guard on each seal; checkpoint insert aborts unless the chain is complete                      |
| Share links                      | `os-shares.ts`                                          | Session insert re-checks the link; revoke and sessions in one batch                                                  |

Gaps found, each filed:

| Gap                                                                                                          | Risk                                                                                              | D1 fix                                                                            | Work     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------- |
| Demoting an owner: count owners, call Descope, then a plain `UPDATE` (`apps/api/src/rpc/routers/members.ts`) | Two concurrent demotions can leave an organization with no owner                                  | Put the owner count in the `UPDATE`'s `WHERE`                                     | 939f67b8 |
| Stripe webhooks: "newer event already processed?" is a separate read; `markProcessed` has no lease token     | Two events for one customer can apply out of order; an expired worker can finish after a re-claim | Per-entity high-water column with a guarded write; lease token on `markProcessed` | 68164f7c |
| Approval resolve, then decision edges as a later write (`queries/approvals.ts`)                              | A crash leaves a resolved approval without edges                                                  | Same batch, keyed off the resolved row                                            | 338c4dc2 |

Postgres transactions would make much of this code simpler (no `changes()`
chaining, no cap triggers, no abort trick in the chain checkpoint), but
they would not fix anything that is broken today. Counts over the 439
query modules: 278 both read and write, 145 use `db.batch()`, ~31 use a
version compare-and-set, and the D1 migrations hold 249 aborting triggers.
That trigger and batch logic is also what a port would have to rewrite.

## The three options

|                          | Stay on D1 (history out)                                                                                                                                                                                                                                                                                           | Split the core per organization into Durable Objects                                                                                                                                                          | Postgres via Hyperdrive                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Size**                 | 10 GB hard cap per database. Core alone is 2.3 (2.8 with memory) GB today                                                                                                                                                                                                                                          | 10 GB per object; no realistic organization comes near it                                                                                                                                                     | No practical cap                                                                                                                                                                                                                                                                                                                                    |
| **Contention**           | One writer thread per database: every statement waits behind the slowest one. Throughput = 1 / average statement time                                                                                                                                                                                              | One thread per organization; one busy organization no longer slows the others. Cross-organization reads (platform admin, catalog, billing reconciliation, identity lookup by email) need a separate directory | Many concurrent connections; row locks instead of a database-wide queue. Hyperdrive pool on our config: 15 origin connections                                                                                                                                                                                                                       |
| **Transactions**         | `db.batch()` only; guarded statements and triggers                                                                                                                                                                                                                                                                 | Real transactions inside one organization (DO SQLite `transactionSync`); nothing across organizations                                                                                                         | Full transactions, `SELECT … FOR UPDATE`, serializable isolation                                                                                                                                                                                                                                                                                    |
| **Latency from Workers** | Same Cloudflare network; reads can use read replicas (enabled: `read_replication auto`)                                                                                                                                                                                                                            | Lowest: code runs next to its data                                                                                                                                                                            | Every query crosses to the Postgres host (Frankfurt). Hyperdrive pools connections and caches some reads. Our one test (Work ac6a827a, 5–9 Nov) missed every p95 < 150 ms target with 44 failed operations; the fair re-run (e917a6a5) never ran                                                                                                    |
| **EU residency**         | EU jurisdiction database (`jurisdiction: eu`, today)                                                                                                                                                                                                                                                               | EU jurisdiction Durable Objects (already used for workspaces)                                                                                                                                                 | Hyperdrive only connects to a Postgres; it does not host one. Residency is the Postgres host's: an EU region and an EU-processing contract with that provider (PlanetScale Frankfurt today), plus its backups and replicas. Hyperdrive's query cache runs on Cloudflare's network: turn caching off for tenant data unless its location is verified |
| **Self-hosting**         | Runs on celld (D1 is supported)                                                                                                                                                                                                                                                                                    | Runs on celld (DO SQLite is supported)                                                                                                                                                                        | celld has no Hyperdrive; self-hosters need a Postgres and a direct driver path                                                                                                                                                                                                                                                                      |
| **Migration cost**       | None; continue the history move and statement fixes                                                                                                                                                                                                                                                                | Rewrite every core query to route by organization, build a cross-organization directory, migrate data: months                                                                                                 | Port ~2,100 dialect-specific SQL pieces and 249 triggers, dual-run, cutover with a write pause: many weeks. The earlier Postgres copy was deleted (0dab1f186, restorable from its parent)                                                                                                                                                           |
| **Running cost**         | Included (D1 storage and reads)                                                                                                                                                                                                                                                                                    | Included (DO storage and requests)                                                                                                                                                                            | PlanetScale PS-10 + replicas (provisioned 5 Nov) plus a bigger tier for real load                                                                                                                                                                                                                                                                   |
| **History tier**         | History leaves main into one EU log store per organization (Work c5642d65), with the EU R2 archive as the permanent copy. Until then, a chain of EU logs databases with one ops step (new database, binding, migrations) per 6 GB rotation, and readers merge partitions. No single evidence export yet (9967af3a) | Same as D1: per-organization log stores fit this option naturally                                                                                                                                             | One Postgres could also hold history in partitioned tables with no rotation, but only on a host whose EU residency is contractually settled. The R2 archive stays either way. Iceberg on R2 is blocked for EU data today                                                                                                                            |

Splitting the core per organization is the wrong cut today: the workspace
split already moved the per-tenant bulk out, and what remains is mostly the
cross-organization part (identity, membership, billing, catalog, Work
across projects). It stays an option for tedi memory and organization
memory if those grow; they are already organization-keyed.

## Triggers that decide it (after a week of snapshots)

Read from the sheet over seven consecutive days, after the history moves
and the statement fixes in the follow-up Work have been deployed.
Postgres becomes the plan if **any** of these holds:

| #   | Measure (sheet column)                                             |                     Today | Stay on D1 while                                                            | Move the core to Postgres when                                                                                |
| --- | ------------------------------------------------------------------ | ------------------------: | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Core + memory size (Share of file MB, groups core + memory)        |                  2,851 MB | < 5,000 MB and growing < 50 MB/day                                          | > 6,000 MB, or growing > 100 MB/day for 7 days                                                                |
| 2   | D1 busy time (DB time s 24h, total)                                |                   9,551 s | < 21,600 s/day (25% of the day)                                             | > 43,200 s/day (50%) on 3 of 7 days                                                                           |
| 3   | D1 overload errors (D1 overload 24h + Temporarily unavailable 24h) |                    17,135 | < 100 per day                                                               | > 1,000 per day on 3 of 7 days, after the fixes in d25d03ba are deployed                                      |
| 4   | Correctness                                                        | 3 gaps, all fixable on D1 | Every read-decide-write gap fixable with one guarded statement or one batch | A required invariant (billing, admission, ownership) that cannot be written as one guarded statement or batch |
| 5   | Self-hosting                                                       |           Cloudflare only | Self-hosters run on Cloudflare or celld                                     | A customer contract requires self-hosting on infrastructure with Postgres but without D1                      |

Trigger 3 is far above its line today. That is the point of fixing the
statements first: if errors stay above 1,000 a day once the multi-second
statements are gone, D1's single thread is the limit and Postgres is the
answer.

Analytics Engine is not a history tier for this decision: it keeps three
months and samples at high volume.

If trigger 1, 2 or 3 fires, check that it is not history: the history
group must be under 30% of the file before the core is blamed. If 2 or 3
fires with the core under 5 GB, the next step is a fair Postgres
benchmark (e917a6a5 at production query shapes), not the port itself.

## Follow-ups

- Fix the expensive statements that dominate D1 time (see the top table;
  each gets its own Work Item).
- Fix the three read-decide-write gaps above.
- Decide on 4 December 2026 with the sheet; stop the daily job then
  (it stops itself after that date).
