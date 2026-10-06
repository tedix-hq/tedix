---
summary: "Cognitive runtime contract for sessions, events, streaming, run control, and runtime-neutral status"
read_when:
  - Updating cognitive runtime APIs or event ingestion
  - Debugging chat/session/ledger behavior
  - Checking runtime-neutral status and diagnostics contracts
title: "Cognitive runtime"
---

# Cognitive Runtime

The cognitive runtime is the product contract for tedi sessions, turns, events,
approvals, artifacts, and run control. It is runtime-neutral at the API
surface. The Agent runtime executes every tedi; workstation leases add
OS/process capability when needed.

## Contract

| Concern          | Contract                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Session identity | Callers use conversation/session/run ids; runtime-local labels stay adapter metadata                                       |
| Event stream     | `tedi_runtime_events` carries `message.*`, `run.*`, `tool.*`, `approval.*`, memory, decision, and artifact events          |
| Streaming text   | Cumulative and chunked deltas are normalized before message completion                                                     |
| Run control      | Stop/cancel terminates the active workflow, or records terminal state when the run already finished                        |
| Status           | `TediRuntimeStatus` exposes root health plus `canonical` and `backendDiagnostics` projections                              |
| Persistence      | The D1 ledger, artifacts, and trace bundles are the record; runtime-local buffers are diagnostics only                     |
| Completion       | Tool receipts state supported and unsupported claims; a started job is pending work, never proof its target outcome passed |

## Source Paths

| Area                    | Path                                                     |
| ----------------------- | -------------------------------------------------------- |
| API router              | `apps/api/src/rpc/routers/cognitive-runtime.ts`          |
| Contract schemas        | `packages/api-contract/src/schemas/cognitive-runtime.ts` |
| Runtime events table    | `packages/db/src/schema/cognitive-runtime.ts`            |
| Agent runtime turn loop | `apps/tedi-runtime/src/do.ts`                            |
| Agent runtime MCP mount | `apps/tedi-runtime/src/mcp-mount.ts`                     |
| Context bridge          | `packages/context-core`, `apps/tedi-runtime/src/brain`   |

## Event Normalization

Adapters may emit different low-level shapes; the ledger converges on:

- `message.received` — the accepted user turn and attachments.
- `run.started` — run identity and backend metadata.
- `message.delta` — cumulative or chunked; the promoter keeps the longest valid
  content per run/message. A Home turn streams one answer through
  `createAnswerDeltaBatcher` (`apps/api/src/kernel/answer-delta-batcher.ts`),
  which flushes before `message.completed`, so a consumer never sees the
  completed row ahead of the last delta.
- `tool.started` / `tool.completed` — paired by occurrence-aware tool-call ids.
- `message.completed`, `run.completed`, `run.failed`, `run.canceled` — terminal.
- Approval, memory, decision, and artifact events share the trace context and
  actor metadata.

Do not add runtime-specific event names to product UI or public contracts
except as adapter metadata.

### Home live events

The Kernel DO writes two extra kinds on the parent Home run
(`kernel_runtime_events`; writers in
`apps/api/src/rpc/routers/kernel/home-live-events.ts`). Phase-specific fields
live in `payload`, because the OS frame parser strips unknown top-level keys.

- `message.phase` — one row per phase transition. `payload.phase` is a
  `CHAT_RUNTIME_PHASES` value (`packages/chat-transport/src/runtime-frames.ts`):
  `preparing_context`, `planning`, `generating`, `using_tool`, `delegating`,
  `finalizing`; `payload.detail` is optional display text such as a tool or
  tedi name.
- `message.reasoning` — the planner's provisional rationale as it streams,
  batched on the same cadence as answer deltas so each run stays at a few rows
  (`listKernelRuntimeEvents` pages by offset). It is display-only: it never
  becomes the answer, never enters the transcript, and nothing in the ledger,
  accounting, or approvals reads it. The OS drops it when the run ends.

Event kinds are a TypeScript enum; the column has no D1 `CHECK`, so adding a
kind needs no migration.

Delegation outcomes are metadata, never body text: the delegated
`message.completed` row and the parent run carry
`metadata.delegationProof = { verdict: "verified" | "unverified" | "failed", note?, reason? }`
and, for output-schema task mode, `metadata.outputContract = { met: false, errors }`.
The assistant body is exactly what the tedi wrote.

## Status And Diagnostics

`TediRuntimeStatus` has three layers: root fields for current callers,
`canonical` for the runtime-neutral health projection, and
`backendDiagnostics` for adapter details. Diagnostic kinds stay generic:
`connection`, `gateway`, `lifecycle`, `adapter`, `unknown`.

### Orphan runs

`flywheel.get_orphan_run_health` is an org-scoped, read-only view of the same
D1 predicate the scheduled orphan sweep uses: an old `run.started`, no
terminal event, no recent message/tool/step activity, no unresolved approval,
and no terminal or recently active backend dispatch. The response is bounded:
`candidateCountRelation: "at_least"` with `truncated: true` means the count is
a lower bound. Samples mark `succeededLost` when success exists but the
terminal event was lost.

Analytics signals such as `dangling_turn` and `facet_turn` are diagnostics
only. Never use them to abort work or synthesize a terminal event — a
long-running workstation operation can be silent for minutes. Only the full
orphan predicate drives the sweep (tests:
`apps/api/src/rpc/routers/cognitive-runtime.orphan-sweep.test.ts`).

## Runtime Boundary

This section owns the runtime-boundary contract. The platform (harness,
ledger, policy) owns identity, memory, sessions, approvals, trace, and
promotion. Runtime substrates supply execution:

- **Agent runtime** — the tedi's session, tool use, skills, schedules, voice,
  browser sessions, and MCP.
- **Workstation lease** — additive OS/process capability: shell, filesystem,
  native dependencies, dev servers, long-running processes, ports, and
  browser/CDP sessions. It reports results to the same session and trace and
  never owns memory, identity, or product status.
- **Workflows** — retry/checkpoint work outside one conversational turn.
- **Dynamic Worker Loaders** — bounded Code Mode, stored code tools, skill
  isolates, and tenant bundles.

The operator sees the work and its results, not a runtime selector.

### Store only what must survive

Session history, the cognitive ledger, memory, and run records persist.
Everything reconstructable is re-derived from current config, so config
changes reach a running tedi without losing state (`apps/tedi-runtime/src/do.ts`):

- **Per turn** — conversation preparation resolves the identity prompt, MCP
  instructions and cognitive addenda into a governed native Pi configuration.
  Pi owns the durable conversation context used by inference.
- **TTL** — the MCP tool surface re-syncs against D1 tool config on a short
  TTL (`ensureSynced`, `packages/mcp-client-core/src/runtime.ts`).
- **Version tag** — the cached identity prompt carries `systemPromptVersion`,
  so a code-level prompt change applies on the next turn after deploy.
- **DO lifetime** — the model policy (`runtime_profiles.config.modelPolicy`) is
  resolved once per DO lifetime, with the last value kept as a fallback; a
  change applies on the next cold start.

The deliberate inverse: skill workflow runs pin their source snapshot at
dispatch ([skills.md](skills.md)). Rebuild for turns, pin for runs.

## Special Session Classes

Both are keyed by session-id prefix, defined in
`packages/api-contract/src/utils/runtime-identity.ts`.

**Blind verification (`evidence:judge:`).** Source grounding asks the tedi that
wrote an interpretation whether a cited passage supports it. That only works
if the judge cannot read its own accumulated belief. On these turns the
runtime skips the cognitive addenda before any memory read
(`apps/tedi-runtime/src/cognitive-addenda.ts`), runs on a facet with an empty
session tree, writes no observations, and stays out of the daily log. Identity,
model policy, and persona still apply. Producer:
`apps/skill-runtime/src/evidence.ts`.

**Workflow synthesis (`workflow:synth:`).** Bounded, self-contained synthesis
for skill workflows runs on a fresh per-run `SynthesisSessionFacet` with the
tedi's normal model and persona but no tools, no MCP schemas, no prior history,
and no post-turn learning. Producers must use the prefix only for prompts that
contain every needed input; a missing fact is returned as missing. Admission,
usage settlement, session rows, and run events stay with the parent.

## Validation

| Change              | Check                                                                |
| ------------------- | -------------------------------------------------------------------- |
| Schema/status shape | `packages/api-contract` typecheck/tests and focused API router tests |
| Streaming promotion | `apps/api/src/rpc/routers/cognitive-runtime.test.ts` delta cases     |
| Run cancel/stop     | Kernel/runtime cancellation tests plus a live child-run readback     |
| Event ingestion     | D1 readback from `tedi_runtime_events` and the Tedix OS transcript   |

## Related

- [harness.md](harness.md), [kernel-execution-model.md](kernel-execution-model.md)
- [../tedi/agent-runtime.md](../tedi/agent-runtime.md)
