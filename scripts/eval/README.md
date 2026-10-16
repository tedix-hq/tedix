# Chat latency eval

Run the same 20 fictional requests before and after a managed release:

```sh
TEDIX_ORGANIZATION=<selected-organization> bun scripts/eval/chat-latency.mjs \
  --profile connect --label before --out /tmp/chat-latency-before --rounds 2
```

Use a new output directory for each measurement. The script creates its own
private scratch workspace. Seven creates and three edits cover documents,
sheets and presentations; ten questions cover explanation, translation and
arithmetic.
Each request runs sequentially through `tedix -w connect chat -p` with a fresh
conversation and without repository context. Only write requests include the
scratch workspace name and id in their prompt: this CLI has no selected OS
Workspace flag. Exact output type, title, workspace, content and current
revision are checked through separate canonical reads. Sheet cell values are
compared exactly; answer checks require topic terms and the answer route.
These checks are a bounded regression eval, not a general semantic judge.

`results.json` contains wall time for the chat command, phases from
`tedix inspect <runId>`, outcomes, model and actual server isolate tags. Raw
inspect files can contain private organization context; keep the evidence
directory outside the source repository. Verification reads and cleanup are
excluded from chat wall time. Missing measurements remain null. Percentiles
use nearest rank and include failed runs with measured timings.

- Context: `plannerFirstProgress - routePlanStarted`.
- Route first token: the winning lane's first partial, plus the configured
  launch delay for a hedge. This is a structured partial, not an answer token.
- Route decision: `routePlanEnded - plannerFirstProgress`, including generation
  of the complete route object and its answer.
- Write plan: `writeProposalPlanEnded - writeProposalPlanStarted` for writes.
- Execute: the durable run's `completedAt - kernelWriteExecutedAt`; this
  includes the execution claim and tool call up to its completion timestamp.
- First answer: the first answer delta from enqueue, when recorded.

The first/repeat rounds do not imply cold/warm. Only the server's
`kernelTurnTimings.isolate.tag` establishes that distinction. The script does
not evict production objects; report cold sample counts, including zero,
without inferring cold performance from warm runs.

Every run archives its chats, scratch outputs and workspace in `finally`,
including after SIGINT or SIGTERM. Signals stop new requests and allow the
in-flight request to finish before cleanup. Each archive has a separate
readback, with bounded exponential backoff when the archive is not confirmed
(including null rate-limit results). Normal approval policy applies. A parked
approval is a failed outcome, never an instruction to auto-approve. Chat
mutations are not retried.

Re-score saved traces and output readbacks without live calls:

```sh
bun scripts/eval/chat-latency.mjs --recheck --out /tmp/chat-latency-before
bun test scripts/eval/chat-latency.test.ts
```
