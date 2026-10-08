---
summary: "Brain storage roles, the single write boundary, admission and supersession, recall rules, and Neo4j projection invariants"
read_when:
  - Updating brain writes, retrieval, memory feedback, or fact lifecycle behavior
  - Checking how long-term memory differs from chat logs and projections
title: "Brain and memory"
---

# Brain and memory

The brain is a tedi's long-term, attributable memory: compact facts with
provenance and lifecycle, not a chat archive. D1 is the source of truth; R2
holds referenced payloads; Cloudflare Agent Memory and Neo4j are rebuildable
read models. Memory survives runtime replacement, so no runtime-local file,
SDK Session block, or `agent_memory_*` tool is ever the brain.

Schema: `packages/db/src/schema/memory-graph.ts`. Lifecycle logic:
`packages/db/src/queries/fact-lifecycle.ts`. Write quality:
`apps/api/src/services/brain-write-quality.ts`.

## Write path

`memory_learn` is the only write boundary for long-term facts.

```text
producer -> quality envelope -> graph-linkage admission -> memory_learn
  -> D1 fact + edges (+ graph_projection_outbox rows, same batch)
  -> Agent Memory projection (session fact:{factId}, background)
  -> leased outbox drain -> Neo4j
```

- **Admission.** A fact enters at normal confidence only if it links to
  existing knowledge (explicit edge, stable topic key, or same-domain overlap).
  Unlinked facts still enter, but on 7-day probation with confidence capped at
  0.5; a later vector pass may upgrade them.
- **Enforcement keys on the authenticated caller class, not payload labels.**
  Every agent-authenticated write is enforced however it labels its `source`;
  user JWT and API-key callers are enforced only for `afterTurn` writes
  (`shouldEnforceFactAdmission`).
- For `afterTurn` facts the user turn is passed as request-only source text to
  `apps/api/src/services/jev-memory-quality.ts`, so an extracted fact cannot
  validate itself. Only a digest and the verdict are stored.
- **Supersession.** Stateful claims (credential state, inventory,
  reachability) carry stable topic keys such as
  `org:<orgSlug>.connector.<appSlug>.credential_state`. A new fact on an active
  key sets `validTo` on the old one and adds a `SUPERSEDES` edge; history is
  never deleted. Content hashing alone is not enough for this state.
- Extracted entities are graph anchors marked `do_not_inject_automatically`
  (`apps/tedi-runtime/src/brain/bridge.ts`), so a name that merely appeared in a
  task does not inflate recall.
- Agent-written memory is an observation, never an instruction, until a human
  confirms it, a trusted source owns it, outcomes reinforce it, or reflection
  promotes it with source links.
- Application code never writes Neo4j directly, and no new automated producer
  ships without the producer gates: source, explicit scope, one concise claim,
  conservative confidence, dedup first, no secrets or raw transcripts,
  probation by default, per-cycle budget.

## Sensitive data

The brain may hold sensitive customer knowledge because it has lifecycle,
erasure, retention, and audit. Model adapters do not: raw transcripts,
documents, emails, HR, health, payment proofs, and secrets never enter training
exports by default. Reusable behavior belongs in skills, directives, and evals.

## Lifecycle and reflection

```text
probation -> retrieved or validated -> active
          -> contradicted -> validTo + SUPERSEDES
          -> stale / low confidence -> archived + recall cleanup
```

Invalidated and archived facts stay for audit, leave default recall, and are
removed from Agent Memory. Unretrieved probation facts auto-archive after their
TTL (`sweepExpiredProbationFacts`, daily, batched per org).

`MemoryReflectionWorkflow` runs a daily full per-org sweep and a tedi-scoped
`recent` pass on session compaction (`apps/api/src/services/compaction-reflection.ts`).
The compaction instance id derives from the `context.compacted` event id for
exactly-once, and the trigger never fails the ledger write. A run with zero
state transitions logs a warning: consolidation that only appends has failed.

Operators and tedis clean up noisy facts through `review_memory_fact`, never
direct SQL; rejected facts default to `do_not_inject_automatically`.

## Recall

`apps/api/src/integrations/cloudflare/agent-memory.ts` owns projection and
candidate recall (profiles `org-<orgId>` and `org-<orgId>-tedi-<tediId>`).

- Only candidate ids are used; the provider's synthesized answer is never
  injected. An empty answer is a no-match signal. D1 rehydrates candidates and
  rechecks ownership, visibility, lifecycle, review, and use policy.
- Failed or empty recall returns nothing — it never substitutes unrelated
  high-confidence facts. Projection is not atomic with D1; reflection
  reconciles it.
- Recall is untrusted input and cannot authorize actions. Context policy is
  independent of the selected model.
- **Home** (`assembleHomeContext`) starts one bounded, fail-soft recall at DO
  ingress (`startIngressRecall`) and falls back to static top-N facts on
  timeout. Ordinary tedi turns get org and own-tedi recall; authenticated
  embedded turns get session-only context; direct MCP gets only explicit memory
  calls.
- A private fact is reachable only by its owning tedi, including in dedup
  scans; a read without tedi identity sees only `org`/`shared` visibility.
- A rationale arriving without fact references gets bounded auto-citations
  (`apps/api/src/services/rationale-evidence.ts`). Citation-rate metrics count
  only explicit fact-id keys, not generic `sources`.

## Neo4j projection

Neo4j answers graph-shaped questions (traversal, FastRP, PageRank, decision
provenance); D1 owns writes, ordering, lifecycle, and read admission.

- The consumer holds one lease per organization, reads a strict sequence
  prefix, and advances the cursor only while the same lease owns the expected
  prior cursor. A retrying or poisoned head blocks its successors; ordering is
  per organization, with no global exactly-once.
- Repair is a resumable, checkpointed scan stamped with one epoch, followed by
  an org-scoped sweep of unstamped managed rows — never a global garbage
  collector. Missing `(orgId, id)` uniqueness constraints fail certification.
- `graph_projection_readiness` admits base reads only after full repair, an
  empty backlog, sampled parity, and exact per-kind count parity with D1.
  GDS-derived reads additionally need a matching `gdsWatermark`/`gdsEpoch`;
  stale GDS closes derived reads without blocking traversal.
- Callers must distinguish an empty neighbourhood from graph unavailable,
  projection lagging, stale GDS, and facts excluded by read gates.

Flywheel diagnostics (`/flywheel/*`, including the strategy map and knowledge
market) are diagnostics, never targets or reward inputs; a `supported`
hypothesis means consistent, not causal.
