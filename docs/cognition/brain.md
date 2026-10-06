---
summary: "Brain storage, fact lifecycle, write gates, retrieval, graph projection, and cleanup"
read_when:
  - Updating brain writes, retrieval, memory feedback, or fact lifecycle behavior
  - Checking how long-term memory differs from chat logs and projections
title: "Brain and memory"
---

# Brain and memory

The brain is a tedi's long-term, attributable memory: compact facts that can be
searched, validated, invalidated, linked to decisions, and reviewed over time.
It is not a chat log archive. The loop it serves:

```text
observe -> learn -> retrieve -> decide -> attribute -> feedback -> clean up
```

Every automated write keeps enough provenance for later audit, and every
retrieval path prefers active, used, outcome-tested knowledge over volume.

Memory is runtime-neutral: the `tedi_runtime_events` ledger, D1 brain state,
R2-referenced artifacts, and the rebuildable Cloudflare Agent Memory and Neo4j
read models over that state. A tedi's memory survives runtime replacement, so
no local `MEMORY.md`, daily log, or runtime cache is ever the source of truth.

## Stores

| Store                   | Role                                                                                         | Never treat as                                           |
| ----------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D1                      | Source of truth for facts, lifecycles, edges, rationale, skills, expertise, projection state | A disposable cache                                       |
| R2 / Artifacts          | Large immutable payloads, source snapshots, traces, replay bundles referenced by D1          | A queryable fact store                                   |
| Cloudflare Agent Memory | Per-tedi semantic recall over eligible D1 facts                                              | The source of truth for validity, identity, or lifecycle |
| Neo4j                   | Rebuildable relationship, traversal, algorithm, and provenance read model over D1            | A write or lifecycle store                               |
| Runtime-local memory    | Agent-runtime scratch, SDK Session context blocks, `agent_memory_*` runtime tools            | The brain                                                |
| External systems        | Federated knowledge queried through live APIs                                                | Tedix state unless captured with provenance              |

Working memory (turn observation and compaction) lives in `packages/context-core`
and `apps/tedi-runtime/src/brain`, which bridge selected observations into D1.

Live row counts, tool counts, and graph sizes drift; query D1 or the Activity
view instead of copying them into docs.

## Agent Memory projection

`apps/api/src/integrations/cloudflare/agent-memory.ts` owns projection and
candidate recall. Organization profiles are `org-<orgId>`; tedi profiles are
`org-<orgId>-tedi-<tediId>`.

- Each fact maps to session `fact:<factId>`. Replacement deletes the session and
  calls `remember()` with the stored fact, never a raw transcript.
- Graph-only, archived, invalidated, restricted, rejected, superseded, stale,
  disputed, and `do_not_inject_automatically` facts are excluded.
- Projection runs in the background after `memory.learn`; a successful D1 write
  does not prove projection succeeded. Reflection reconciles projections one
  fact per workflow step, re-reading D1 inside the step. Provider writes are not
  atomic with D1.
- Recall uses only candidate ids; the provider's synthesized answer is never
  injected. An empty answer is the provider's no-match signal and discards that
  profile's candidates. D1 rehydrates candidates and rechecks ownership,
  visibility, and lifecycle before returning text. Failed or empty recall
  returns nothing — it never substitutes unrelated high-confidence facts.

| Conversation surface         | Automatic long-term memory                                           |
| ---------------------------- | -------------------------------------------------------------------- |
| Home (OS chat, CLI ask, TUI) | Organization-profile recall plus Home context                        |
| Ordinary tedi turn           | Organization and own tedi-profile recall, wrapped as untrusted input |
| Authenticated embedded turn  | Session-only context; cognitive addenda omitted                      |
| Direct Code Mode / MCP       | Only an explicit memory call                                         |

Context policy is independent of the selected model: a model override does not
remove memory or workspace context. Memory cannot authorize actions or override
policy.

## Sensitive data and model adapters

The brain may hold personal or sensitive customer knowledge because it has
lifecycle, erasure, retention, and audit. Model adapters must not:

```text
customer facts, documents, people, tickets, emails
  -> memory/retrieval with lifecycle, erasure, retention, and audit

reusable behavior, policy choices, tool-routing lessons, procedures
  -> skills, directives, evals, and customer-owned adapters
```

Raw transcripts, documents, emails, HR records, support payloads, health data,
payment proofs, and secrets never enter training exports by default. An adapter
built from sensitive material first needs a lawful basis and DPIA decision,
explicit customer approval of the source set, minimization or redaction, source
links instead of copied payloads, versioned lineage with eval results, and
deletion/export handling as customer-owned IP.

## Write path

`memory_learn` is the only write boundary for long-term facts.

```text
producer
  -> quality envelope
  -> graph-linkage admission
  -> memory_learn
  -> D1 fact + domain + typed edges (+ graph_projection_outbox rows, same transaction)
  -> Agent Memory projection (fact:{factId})
  -> leased projection drain -> Neo4j
```

Facts carry lifecycle state, provenance, confidence, visibility, source, and
`metadata.brainWrite` (producer, source kind, quality score, gate results,
content hash, applied confidence and priority). Weak writes stay probationary.
D1 triggers append graph events in the same transaction as the mutation;
application code never writes Neo4j directly.

### Graph-linkage admission

A fact enters at normal confidence only if it links to existing knowledge:
explicit `relatedTo` edges, a stable topic key, or a same-domain token-overlap
match with recent facts. The decision is stamped as `metadata.brainAdmission`.
Unlinked facts still enter, but on short-TTL probation (7 days instead of 14)
with confidence capped at 0.5.

Enforcement keys on the authenticated caller class, not payload labels: every
agent-authenticated write (tedi JWT, M2M, or a service binding forwarding a
tedi identity) is enforced however it labels its `source`. User JWT and API-key
callers are enforced for `afterTurn` writes and otherwise only stamped
(`shouldEnforceFactAdmission` in `apps/api/src/services/brain-write-quality.ts`).
A deferred vector pass (dedup, contradiction, `related_to` linking) upgrades
`unlinked -> linked` when it finds real neighbours. Decision logic:
`packages/db/src/queries/fact-lifecycle.ts`; gate application:
`apps/api/src/rpc/routers/memory-graph.ts`.

For `afterTurn` facts, the user turn is passed as request-only source text to
`apps/api/src/services/jev-memory-quality.ts`, so an extracted fact cannot
validate itself. A strong unsupported or transient verdict restricts automatic
injection and caps confidence. Only a digest and the verdict are stored.

### Scope routing

A fact's owner is decided before it is written.

| Scope        | D1 shape                                              | Use for                                                                  | Promotion                                        |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Org          | `orgId`, `tediId = NULL`, `visibility = org/shared`   | Customer knowledge, operating rules, connector state, org-wide decisions | Needs a source, validation, or operator approval |
| Tedi         | `orgId` + `tediId`, usually `private`                 | Worker experience, rationale, tool outcomes, tentative lessons           | May be cloned into org memory after validation   |
| Kernel       | Org-scoped runtime and reflection records             | Delegation policy, Home context, route decisions, parent/child runs      | Never silently becomes tedi instructions         |
| Session/task | Runtime submissions, Work Items, traces, session keys | Active investigations, handoffs, short follow-ups                        | Expires unless promoted by outcome               |
| Graph entity | Domain/entity node or projection edge                 | Tools, services, documents, people, domains, relationships               | Becomes a recall fact only if it carries a claim |

`apps/tedi-runtime/src/brain/bridge.ts` writes extracted entities as graph
anchors marked `do_not_inject_automatically`, so a tool or domain name does not
inflate recall just because it appeared in a task.

### Observation vs instruction

Agent-written memory starts as an observation, not an instruction. It becomes
instruction-grade only when a human confirms it, a trusted source system owns
it, repeated successful outcomes reinforce it, or reflection promotes it with
source links and rollback metadata. Instruction-grade memory states who may
follow it, where it applies, and why it is trusted.

### Topic keys and supersession

Stateful claims carry stable topic keys so newer claims replace older ones
without deleting history:

```text
org:<orgSlug>.connector.<appSlug>.credential_state
org:<orgSlug>.cms.<collection>.inventory
tedi:<slug>.operating_rule.approval_gating
```

A new fact sharing a topic key with an active one sets `validTo` on the old
fact, adds a `SUPERSEDES` edge, and repoints recall. Content hashing alone is not
enough for credential, installation, inventory, or reachability state.
`packages/db/src/schema/memory-graph.ts` stores `topic_key`, `memory_scope`,
`use_policy`, and `review_status`.

### Rationale bridge

`apps/tedi-runtime/src/brain/rationale-bridge.ts` correlates rationale closure
to the same run before auto-completing outcomes, ignores rationale-lifecycle
observations (so housekeeping does not create more records), attaches the
turn's `runId` and tool-call refs to every record it creates (unlinked writes
are rejected), and stamps a `{ kind: "run" }` proofRef on success. A record
whose `runId` matches the current turn completes in the same turn; other
heuristic completions wait five minutes.

When a rationale arrives without fact references, the API runs a bounded D1
search and stores high-confidence active matches under
`evidence.brain.autoCitations` (`apps/api/src/services/rationale-evidence.ts`).
Fact references are parsed consistently across `factIds`, `retrievedFacts`,
`sources`, and nested provenance by
`packages/api-contract/src/utils/fact-evidence.ts`.

## Fact lifecycle

```text
memory_learn -> probation
  -> retrieved or validated -> active
  -> contradicted -> validTo set + supersedes edge
  -> stale or low confidence -> archived + recall cleanup
```

- `valid_from`/`valid_to` preserve bi-temporal history; contradictions
  invalidate rather than delete.
- Invalidated and archived facts are kept for audit, excluded from default
  recall, and removed from Agent Memory.
- Probation facts never retrieved within their TTL (14 days, or
  `metadata.brainAdmission.ttlDays`) auto-archive, both in
  `MemoryReflectionWorkflow` and in a daily fleet sweep
  (`sweepExpiredProbationFacts` in `packages/db/src/queries/fact-lifecycle.ts`,
  batched per org).

### Reflection

`MemoryReflectionWorkflow` (`apps/api/src/workflows/memory-reflection-workflow.ts`)
has two triggers:

| Trigger             | Scope                 | Source                                           |
| ------------------- | --------------------- | ------------------------------------------------ |
| Daily per-org sweep | `full`                | `apps/api/src/jobs/memory-reflection.ts`         |
| Session compaction  | `recent`, tedi-scoped | `apps/api/src/services/compaction-reflection.ts` |

The daily pass does the heavy whole-org work (dedupe, decay, graph algorithms,
capability distillation). The compaction trigger reflects on a conversation at
the moment context is dropped. Exactly-once comes from the workflow instance
id, which is derived from the `context.compacted` event id; the trigger runs
under `waitUntil` and never fails the ledger write.

Every run reports its state transitions (promote, demote, merge, archive) in
the result's `transitions` field. A run with zero transitions logs a warning:
consolidation that only appends is a failed consolidation.

## Producer gates

Automated producers write compact, attributable, bounded facts. The quality
envelope scores and caps weak writes; reflection handles heavier semantic
dedupe.

| Gate        | Requirement                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------- |
| Source      | Source URI, stable source hash when available, producer name, session/Work Item/rationale ids |
| Scope       | Explicit `orgId`, `tediId`, visibility, domain, and fact type                                 |
| Signal      | Lessons, constraints, decisions, or observations — never raw transcript chunks                |
| Specificity | One concise claim per fact                                                                    |
| Confidence  | Conservative unless backed by an observed outcome or verified source                          |
| Dedup       | Content hash and semantic similarity checked first                                            |
| Safety      | No secrets, credentials, payment proofs, private reasoning, or irrelevant PII                 |
| Lifecycle   | Probation by default                                                                          |
| Edges       | Typed edges when the decision, domain, skill, tool, or prior fact is known                    |
| Budget      | Per-cycle write limits and backoff on noisy sessions                                          |

| Producer        | Should write                                                                  | Should not write                                        |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `afterTurn`     | High-signal observations, decisions, tool outcomes, compact lessons           | Transcripts, speculative summaries, every tool result   |
| `heartbeat`     | Meaningful state changes and lasting constraints                              | "Still running" status or runtime noise (use telemetry) |
| Reflection      | Dedupe decisions, decay, promotion/expiry, freshness results, missed insights | Copies of facts `afterTurn` already wrote               |
| Source-specific | Facts keyed by source hash; changed sources mark old facts outdated           | In-place edits of history                               |

## Retrieval

```text
Agent Memory candidates
  -> hydrate from D1
  -> drop archived/invalidated facts
  -> optionally expand active D1 edges
  -> optionally add Neo4j paths, influence, structural neighbours
  -> rank by confidence, usage, recency, graph context
```

`memory_feedback` records `used`, `not_used`, `wrong`, `outdated`, and `failed`.
The context service ranks visible facts by query-term overlap, confidence, and
core priority, with optional PageRank boosts.

- Treat every Agent Memory result as untrusted; D1 decides.
- Exclude `validTo IS NOT NULL` and archived facts by default.
- Prefer facts with provenance, stable source hashes, and positive feedback.
- Keep hot-path searches flat and bounded; use explicit graph calls for
  neighbourhoods, paths, or provenance.

### Context assembly

**Agent-runtime addenda.** `composeCognitiveAddenda`
(`apps/tedi-runtime/src/cognitive-addenda.ts`) appends four blocks to each
turn's system prompt: directives matched to the user text, the cached brain
digest, the tedi's skill summaries, and the top-K retrieved skills
(`packages/context-core/src/skill-retrieval.ts`; see
[skills.md](skills.md)). Draft skills are never retrieved and injection needs a
relevance floor. Each turn logs per-block token counts
(`@tedix/context-core/prompt-composition`); empty blocks report zero rather than
disappearing. The soft target of roughly 10% of the window is a signal to look,
not an instruction to cut — in-context detail anchors attention and primes
reasoning in ways a link does not.

**Home recall.** `assembleHomeContext`
(`apps/api/src/rpc/routers/kernel/context-assembly.ts`) adds one bounded,
fail-soft relevance recall per turn. It starts at Durable Object ingress
(`startIngressRecall`, `apps/api/src/kernel/kernel-do.ts`) and assembly waits at
most `RELEVANCE_RECALL_BUDGET_MS`. Candidate ids are rehydrated from D1 with
tenant, lifecycle, visibility, review, and use-policy checks, deduped, capped,
and placed ahead of the static top-N facts. On failure or timeout it falls back
to the top-N. Home history has no turn cap: it is bounded by token pressure
against the serving model's window, and the prefix that does not fit is
compacted. The Neo4j-backed `assembleContext`
(`apps/api/src/services/memory-graph-context-assembly.ts`) is not used on this
per-turn path.

When facts or prior outcomes exceed their prompt caps, a bounded judgment may
reorder those candidates. It cannot widen visibility, extend the deadline, or
add content; on failure the source order stands.

## Cleanup

Cleanup is a continuous data-quality loop. Real-time writes stay fast and
conservative; reflection does the heavy work, and the projection control plane
owns Neo4j catch-up.

| Lane                    | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| Probation expiry        | Remove unvalidated low-signal facts                            |
| Semantic compaction     | Merge near-duplicates, keeping the stronger fact               |
| Contradiction handling  | Invalidate old facts and link replacements with `supersedes`   |
| Confidence decay        | Lower stale or unused facts; protect frequently used ones      |
| Projection cleanup      | Delete archived/invalidated fact sessions from Agent Memory    |
| Graph projection repair | Resumable full rescan, epoch stamp, ghost sweep, outbox drain  |
| Source freshness        | Re-check source hashes; mark changed facts outdated            |
| Feedback calibration    | Apply outcomes and explicit feedback to confidence and ranking |

Operators and tedis clean up noisy facts through `memoryGraph.review` (tool
`review_memory_fact`), which updates `review_status`, `priority`, `use_policy`,
`visibility`, `topic_key`, and `archived_at` after checking the fact belongs to
the caller's org. Rejected facts default to `do_not_inject_automatically`. Use
the lifecycle API, not direct SQL.

## Neo4j context graph

Neo4j answers graph-shaped questions; D1 stays the source of truth for writes,
ordering, lifecycle, governance, and read admission. It provides Cypher
traversal, GDS FastRP embeddings (vector index `fact_structural_embedding`),
GDS PageRank, provenance edges (`USED`, `IGNORED`, `PRECEDED_BY`), and
visualization subgraphs.

**Projection.** Every managed mutation appends an org-scoped
`graph_projection_outbox` row in the same D1 transaction. The consumer:

- holds one lease per organization and renews it before graph I/O;
- reads a strict sequence prefix, hydrating current rows for upserts and using
  trigger-written tombstones for deletes;
- applies idempotent Neo4j writes and advances the cursor only while the same
  lease owns the expected prior cursor;
- retries a failed head with backoff, then marks it poisoned.

A retrying or poisoned head blocks its successors. Ordering is per
organization; there is no global exactly-once delivery.

**Repair** is a resumable scan of every managed kind. Each page is
checkpointed in D1 and stamped with one repair epoch; a final org-scoped sweep
removes unstamped managed rows. Repair holds the consumer lease and drains
through its starting high-water mark before certification. Uniqueness
constraints on `(orgId, id)` are provisioned explicitly; missing constraints
fail certification.

**Read admission.** The `graph_projection_readiness` row gates base reads. A
read is admitted only when repair is complete and the cursor covers its
high-water mark, the outbox has no pending/retrying/poisoned events, Neo4j is
reachable with its constraints, sampled facts/edges/lifecycles match D1, and
per-kind managed counts match exactly. GDS-derived reads (FastRP, PageRank,
communities) additionally require `gdsWatermark`/`gdsEpoch` to match the base
snapshot; a refresh is stamped only if D1 did not change during it. Stale GDS
closes derived reads without blocking traversal.

Callers distinguish: healthy graph with no neighbourhood, graph unavailable,
projection lagging D1, stale GDS properties, and facts excluded by read gates.
Graph reads return relationships as well as nodes.

### Decision provenance

For a rationale record the graph answers which facts were cited, used, or
ignored; which source created each fact; whether the decision followed a
successful precedent; which domains, skills, tools, and tedis share the
neighbourhood; and whether later feedback changed the facts' confidence or
validity.

## Flywheel diagnostics

Review whether the brain is getting more useful, not just larger. Metrics are
bucketed by `orgId`, `tediId`, domain, producer, and source type across
observe, learn, retrieve, use, decide, outcome, cleanup, and graph stages. The
`/flywheel/*` routes (`packages/api-contract/src/contracts/flywheel-health.ts`,
`apps/api/src/rpc/routers/flywheel-health.ts`) include pulse, fact lifecycle,
producer quality, decision episodes, learning validation, and learning curves.
These are diagnostics, never targets or reward inputs.

- **Strategy map** (`/flywheel/strategy-map`,
  `packages/db/src/queries/strategy-map.ts`) tests assumed cause-and-effect links
  — skill reuse → decision success, run-linked rationale → verified completions,
  consolidation → fact citation — with lagged cross-correlations over daily
  buckets (lag 0–7 days). Each hypothesis reports Pearson r and sample size;
  below 14 paired buckets it is `insufficient_data`, and `supported` requires r
  above a lag-count-corrected noise floor that ships in the payload. `supported`
  means consistent, not causal.
- **Knowledge market** (`/flywheel/knowledge-market`,
  `packages/db/src/queries/knowledge-market.ts`) reports repute (tedi A's skills
  and facts used by tedi B), reciprocity, localness (a tedi using only its own
  skills), and isolates. Fact ownership uses `memory_facts.tedi_id` as a proxy,
  and truncation is reported as a caveat.
- The citation rate counts only explicit fact-id keys (`factIds`,
  `used_fact_ids`, `factAttributions`), not generic `sources` containers, which
  usually hold URLs.

## Tools

Each tedi exposes brain tools on its MCP endpoint (`{slug}.tedi.tedix.dev/mcp`);
aggregate gateways bridge them through `apps/mcp/src/mcp/aggregate-tedis.ts`.
Tool rows are D1 configuration; core tools include `memory_search`,
`memory_learn`, `memory_feedback`, `memory_expertise`, `memory_health`,
`memory_graph_query`, `review_memory_fact`, and `audit_memory_graph`, plus
graph path/influence/decision-trace and flywheel read tools. Influence reads
return results only when both base and GDS freshness checks pass.

## Multi-tenancy and erasure

Every brain object carries `orgId`; tedi-specific facts also carry `tediId`.
Queries filter by org at the storage layer, including Cypher and GDS
projections. A read without a tedi identity sees only `visibility IN (org,
shared)`; a private fact is reachable only by its owning tedi, including in
dedup scans.

Erasure deletes or detaches every projected object for the org/user scope;
recall cleanup and graph repair follow D1. Repair sweeps are limited to the
target `orgId` and an explicit allowlist of managed labels and relationships —
never a global garbage collector.

## Source map

| Area                 | Source                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schemas              | `packages/db/src/schema/{memory-graph,graph-projection,cognitive,rationale-records}.ts`                                                                           |
| Queries              | `packages/db/src/queries/memory-graph/`, `packages/db/src/queries/cognitive/`, `packages/db/src/queries/graph-projection.ts`, `packages/db/src/queries/flywheel/` |
| Write quality        | `apps/api/src/services/brain-write-quality.ts`, `packages/db/src/queries/fact-lifecycle.ts`                                                                       |
| Context engine       | `packages/context-core`, `apps/tedi-runtime/src/brain`                                                                                                            |
| Graph projection     | `apps/api/src/integrations/graph-db/`, `apps/api/src/services/graph-projection-{drain,certification,schema,algorithms}.ts`                                        |
| Reflection           | `apps/api/src/workflows/memory-reflection-workflow.ts`                                                                                                            |
| Runtime memory tools | `apps/tedi-runtime/src/mcp-mount.ts`                                                                                                                              |

## Deliberately not implemented

- No runtime-local store (SDK Session blocks, `agent_memory_*` tools) is the
  brain; promoting one would need D1 provenance, lifecycle, feedback, and
  erasure.
- No provider-synthesized recall answer is ever injected.
- No direct application writes to Neo4j.
- No new automated brain writer without documented producer gates.

## Related

- [Skills](skills.md)
- [Cognitive runtime](runtime.md)
- [Data model](../platform/data-model.md)
