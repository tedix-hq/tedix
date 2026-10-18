# Memory port proof

Run `bun run eval:memory --label=baseline` from the repository root. It prints
one row and appends JSON under `scripts/eval/memory-bench/results/`. No login,
model, Cloudflare account or running server is required. All input is fictional.

`MEMORY_BENCH_SOURCE_ROOT=/path/to/clean/checkout` measures another revision
using exactly the same fixtures. Install that checkout's dependencies first.
`MEMORY_BENCH_OUT=/path` changes the result directory. The runner refuses dirty
production modules and records the full source SHA and fixture hash.
FTS projection migrations are applied in timestamp order, including dependent
recall projections; filesystem directory order is not authoritative.

- Recall: 120 facts in three organizations, 40 entity, temporal, supersession
  and entity-hop queries. Recall@5 and MRR@5 use expected fact IDs. Invalid and
  tenant-leak counts cover every fact in the emitted block. Zero means zero
  observed.
- Lessons: 30 correction/source/lesson triples, 20 prompts. Production lesson
  eligibility and selection run before and after ten sources are invalidated.
  Precision@3 divides relevant hits by three (one relevant lesson per prompt;
  maximum 1/3). Block size is UTF-8 bytes of the rendered hook with the selected
  lessons. JSON also reports top-1 accuracy and server-only P@3/top-1, and names
  the selector used. Numbered prompts mean `Lantern-0` through `Lantern-19`,
  with matching `violet-channel-N` identifiers; all lessons share one topic.
- Freshness: eight simulated gateway reads across two organizations/repos,
  with deliberately over-returning tool doubles. The actual gateway program
  and renderer must exclude another session/project and fulfilled Work whose
  evidence predates the simulated clock by two minutes (stale threshold: one
  minute). The real scope resolver reads isolated temporary Git repos and fake
  profile credentials. Host dispatch and real owner grants remain unmeasured.
- LongMemEval-style: 50 synthetic records in the public field format, covering
  five question types. Report retrieval of answer sessions, not answer accuracy.
  The exported slice can be reused by a comparator. These scores cannot be
  compared to published LongMemEval answer-judge percentages.

The backend calls production `assembleContext` and the production lesson query
through the shared D1 facade. Direct lexical/graph/temporal probes stop the run
on schema errors that production retrieval deliberately handles softly.
Optional local prompt selection is loaded when
present in the measured revision, using the production API's full catalog
before local ranking, as the hook does. Historical proof used the server's
byte-trimmed selection as the catalog; all ten eligible lessons per org fit
the budget in fixture B, so that mismatch did not cause its 15% result. There
are no remote semantic/reranker calls; timings measure in-process local
work only. Distillation output is seeded, so extraction quality is unmeasured.

The four-topic `lesson-ranking-evaluation.test.ts` is a smoke test: each prompt
repeats distinctive words from a different topic. Its 1/4 server to 4/4 local
top-1 result does not establish within-topic identifier discrimination or real
correction rates (its correction events are synthetic). Keep both fixtures.
The smallest Cloud quality follow-up is a fixed set of 20 human-labelled,
paraphrased queries against one authorized fictional corpus: run the same
queries with local retrieval and with live semantic retrieval/reranking, record
top-5 IDs, recall/MRR, provenance, fallback status and latency, and verify that
the remote arms actually ran. Do not equate this offline result with that test.

Hindsight's current checkout moved LongMemEval into
[AMB](https://github.com/vectorize-io/agent-memory-benchmark); see its
`hindsight-system-evals/README.md`, “Benchmarks (AMB)”. The slice reuses the
record shape and question categories; it copies no personal conversations.
Docker is available on the proof host, but the optional offline comparator was
skipped: no running local Ollama service was available. Hindsight retention needs a
model; no hosted credentials or inference were used.

Additional lifecycle fixture (outside the aggregate recall score):

| Feature                             | Fictional fixture                                                                       | Expected result                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observations and standing summaries | [Orchard lifecycle](../../../packages/db/src/queries/memory-graph.observations.test.ts) | Repeated statements share one observation; concurrent reruns add no versions; new evidence retains prior text; contradictions cite both sides; invalidation removes the lost claim from observation and summary, then retracts both when support reaches zero. Evidence reads retain primary-key plans beside 2,000 unrelated active facts. |
