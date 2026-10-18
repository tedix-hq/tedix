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

The local result is recall@5 0.80 → 1.00 and MRR@5 0.491 → 0.547. Consult the
saved result for exact p50/p95 values. These are local query/orchestration
latencies, excluding Cloudflare, authentication and transport. Semantic recall
and AI reranking are unavailable in this offline run; it proves the lexical,
graph and temporal combination, not remote model quality or live p95.
The service tests separately cover parallel starts, hung providers, reranker
fallback, canonical hydration and the total deadline.

No `scripts/eval/memory-bench/README.md` existed on the starting revision.
This separate fixture avoids owning that lane's future runner or lesson files.
