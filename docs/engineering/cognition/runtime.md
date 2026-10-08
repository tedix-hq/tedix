---
summary: "Runtime-neutral cognitive contract (events, status, session classes) and the harness rules for evals and promotion"
read_when:
  - Updating cognitive runtime APIs, event ingestion, or Home live events
  - Debugging chat/session/ledger behavior or orphan runs
  - Changing eval reports, trace bundles, harness versions, or promotion
title: "Cognitive runtime and harness"
---

# Cognitive Runtime and Harness

The cognitive runtime is the product contract for tedi sessions, turns, events,
approvals, artifacts, and run control. It is runtime-neutral at the API
surface: the D1 ledger (`tedi_runtime_events`, `kernel_runtime_events`),
artifacts, and trace bundles are the record; runtime-local buffers are
diagnostics only. Contract schemas live in
`packages/api-contract/src/schemas/cognitive-runtime.ts`.

The harness is everything around a tedi's model loop: context assembly,
tools, rationale, memory, traces, versions, evals, and promotion. Tedix
improves workers by improving the harness, not by exposing runtime choices to
operators.

## Runtime Boundary

The platform owns identity, memory, sessions, approvals, trace, and promotion.
Substrates supply execution only:

- **Agent runtime** ([agent-runtime.md](../tedi/agent-runtime.md)): session,
  tool use, skills, schedules, voice, browser sessions, MCP.
- **Workstation lease**: additive OS/process capability. It reports into the
  same session and trace and never owns memory, identity, or product status.
- **Workflows**: retry/checkpoint work outside one turn.
- **Dynamic Worker Loaders**: Code Mode, stored code tools, skill isolates,
  tenant bundles.

**Rebuild for turns, pin for runs.** Only session history, the ledger, memory,
and run records persist; everything else is re-derived from current config so
changes reach a running tedi without losing state. The MCP tool surface
re-syncs on a short TTL (`ensureSynced`), the identity prompt carries
`systemPromptVersion`, and model policy resolves once per DO lifetime. Skill
workflow runs are the deliberate inverse: they pin their source snapshot at
dispatch ([skills.md](skills.md)).

## Events

Adapters may emit different low-level shapes; the ledger converges on
`message.received`, `run.started`, `message.delta`, `tool.started` /
`tool.completed` (paired by occurrence-aware tool-call ids), and the terminals
`message.completed`, `run.completed`, `run.failed`, `run.canceled`. Do not add
runtime-specific event names to product UI or public contracts except as
adapter metadata. Event kinds are a TypeScript enum with no D1 `CHECK`, so a
new kind needs no migration.

- `message.delta` may be cumulative or chunked; the promoter keeps the longest
  valid content per run/message. Home answers stream through
  `createAnswerDeltaBatcher`, which flushes before `message.completed` so no
  consumer sees the completed row ahead of the last delta.
- **Home live events** (writers in
  `apps/api/src/rpc/routers/kernel/home-live-events.ts`) add `message.phase`
  (one row per `CHAT_RUNTIME_PHASES` transition) and `message.reasoning`
  (display-only provisional rationale; never the answer, never read by the
  ledger, accounting, or approvals). Phase fields live in `payload`, because
  the OS frame parser strips unknown top-level keys.
- **Delegation outcomes are metadata, never body text.** The delegated
  `message.completed` row and the parent run carry `metadata.delegationProof`
  (`verified` | `unverified` | `failed`) and, for output-schema task mode,
  `metadata.outputContract`. The assistant body is exactly what the tedi wrote.
- A started job is pending work, never proof its target outcome passed.

## Orphan Runs

`flywheel.get_orphan_run_health` is a read-only view of the same D1 predicate
the scheduled orphan sweep uses: old `run.started`, no terminal event, no
recent activity, no unresolved approval, no live backend dispatch. A response
with `truncated: true` is a lower bound.

Analytics signals such as `dangling_turn` and `facet_turn` are diagnostics
only. Never use them to abort work or synthesize a terminal event: a
workstation operation can be silent for minutes. Only the full predicate drives
the sweep (`cognitive-runtime.orphan-sweep.test.ts`).

## Special Session Classes

Keyed by session-id prefix (`packages/api-contract/src/utils/runtime-identity.ts`):

- **Blind verification (`evidence:judge:`).** Source grounding asks the tedi
  that wrote an interpretation whether a cited passage supports it, which only
  works if the judge cannot read its own accumulated belief. These turns skip
  cognitive addenda before any memory read, run on a facet with an empty
  session tree, and write no observations.
- **Workflow synthesis (`workflow:synth:`).** Bounded synthesis for skill
  workflows on a fresh facet with the tedi's model and persona but no tools,
  history, or post-turn learning. Use the prefix only for prompts that contain
  every needed input. Admission, usage, and run events stay with the parent.

## Evals and Promotion

Trace bundles (`packages/api-contract/src/schemas/body-certification.ts`) and
harness versions (`packages/db/src/schema/harness-versions.ts`) let a change be
compared and rolled back. A promotion names the component changed, who it
affects, the evals covering it, the rollback path, and the approving gate when
one is required; never promote opaque "it felt better" behavior. Unit tests are
necessary but not sufficient for a production harness claim.

`HarnessEvalRun.report` (multi-trial evals) rules:

- At least two trials, each with a stable ordinal and seed, all pinning the
  same input and settings digests. Retrying `recordEvalRun` with the same run id
  is accepted only when the report is unchanged, so a replay cannot replace the
  measured population.
- Cache boundaries report only tokens eligible for reuse from that exact stable
  prompt section. Do not infer cache opportunity from the previous step's total
  prompt size: it grows with run length and confounds cache behavior with work
  done. Missing boundary observations are missing, not zero.
