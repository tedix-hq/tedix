# Memory port proof

Run `bun run eval:memory --label=baseline` from the repository root. It prints
one row and appends JSON under `scripts/eval/memory-bench/results/`. No login,
model, Cloudflare account or running server is required. All input is fictional.

`MEMORY_BENCH_SOURCE_ROOT=/path/to/clean/checkout` measures another revision
using exactly the same fixtures. Install that checkout's dependencies first.
`MEMORY_BENCH_OUT=/path` changes the result directory. The runner refuses dirty
production modules and records the full source SHA and fixture hash.

- Recall: 120 facts in three organizations, 40 entity, temporal, supersession
  and entity-hop queries. Recall@5 and MRR@5 use expected fact IDs. Invalid and
  tenant-leak counts cover every fact in the emitted block. Zero means zero
  observed.
- Lessons: 30 correction/source/lesson triples, 20 prompts. Production lesson
  eligibility and selection run before and after ten sources are invalidated.
  Precision@3 divides relevant hits by three (one relevant lesson per prompt;
  maximum 1/3). Block size is UTF-8 bytes of the rendered hook with the selected
  lessons.
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
present in the measured revision, matching the hook's catalog/rank flow. There
are no remote semantic/reranker calls; timings measure in-process local
work only. Distillation output is seeded, so extraction quality is unmeasured.

Hindsight's current checkout moved LongMemEval into
[AMB](https://github.com/vectorize-io/agent-memory-benchmark); see its
`hindsight-system-evals/README.md`, “Benchmarks (AMB)”. The slice reuses the
record shape and question categories; it copies no personal conversations.
Docker is available on the proof host, but the optional offline comparator was
skipped: no running local Ollama service was available. Hindsight retention needs a
model; no hosted credentials or inference were used.
