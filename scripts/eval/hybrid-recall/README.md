# Hybrid fact recall evaluation

Run `bun scripts/eval/hybrid-recall/run.ts 10` from the repository root.
The fixed fictional corpus has 60 facts and 25 labeled questions covering
lexical ambiguity, entity-linked deadlines, and relative dates. Expected hits
were written before the first run. `results.json` preserves each query's first
result list and aggregate nearest-rank latency over ten rounds (250 searches).

The before path is the previous 100-candidate confidence inventory followed by
0.65 term overlap + 0.35 confidence, with the core-priority bonus. The after
path calls the production hybrid service against the same D1 facade and the
actual FTS migration, entity resolutions and edges. Both return five results.
MRR@5 assigns zero to a hit absent from the returned five. All fixtures use
fictional organizations; the evaluator makes no network calls or live writes.

The local result is recall@5 0.80 → 1.00 and MRR@5 0.491 → 0.667. Consult the
saved result for exact p50/p95 values. These are local query/orchestration
latencies, excluding Cloudflare, authentication and transport. Semantic recall
and AI reranking are unavailable in this offline run; it proves the lexical,
graph and temporal combination, not remote model quality or live p95.
The service tests separately cover parallel starts, hung providers, reranker
fallback, canonical hydration and the total deadline.

No `scripts/eval/memory-bench/README.md` existed on the starting revision.
This separate fixture avoids owning that lane's future runner or lesson files.
The shared runner landed during rebase; it is also measured against an isolated
checkout of the previous source revision. Its numbered entity names caught a
tokenization regression and its tied timestamps caught an invalidated
contradiction suppressing an active replacement. Both have regression tests.
Fusion gives confidence-ordered graph expansion half weight; query-ranked
lexical, semantic and temporal arms retain full weight. This prevents graph
inventory order from overruling a stronger lexical match.

The shared 120-fact, 40-query comparison in `shared-results.json` uses identical
fixture and harness hashes and clean source revisions:

| Metric                      | Before | Hybrid |
| --------------------------- | -----: | -----: |
| Recall@5                    |  0.825 |  1.000 |
| MRR@5                       |  0.775 |  0.875 |
| Invalid facts surfaced      |      0 |      0 |
| Cross-tenant facts surfaced |      0 |      0 |
| Local p50, ms               |   1.16 |   2.22 |
| Local p95, ms               |   2.78 |   3.44 |

Ordinary recall uses a second FTS projection that omits archived, blocked and
already-ended rows before BM25 ranking. Write triggers synchronize both indexes;
the bounded backfill also prunes naturally expired projection rows. Canonical
eligibility still runs on every candidate. Explicit historical clocks and graph
anchor searches use the full index so the projection cannot hide those facts.

No new binding, variable or ops overlay is needed. The API uses its existing
Agent Memory and AI bindings. D1 arms wait at most 450 ms and semantic recall
at most 150 ms within a 750 ms retrieval deadline. Canonical hydration gets at most 300 ms and optional
reranking at most 100 ms, each capped by the remaining time.
The runtime's outer 800 ms budget includes transport. An absent FTS table uses
the old ranker with the same canonical eligibility checks. An absent or slow AI
binding keeps fused ranks; semantic outages leave the other arms available.
These bounds are fallback behavior, not measured live latency or model quality.
