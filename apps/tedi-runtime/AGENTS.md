---
summary: "apps/tedi-runtime scoped rules: the runtime kernel review contract, do.ts containment, and the sandbox invariants that fail silently"
read_when:
  - Touching anything under apps/tedi-runtime/
  - Changing do.ts, a conversation facet, or the agent turn loop
  - Adding a tool, a Worker Loader call site, or anything that handles external text
title: "apps/tedi-runtime agent guide"
---

# apps/tedi-runtime Agent Guide

Root rules live in `/AGENTS.md`. This file owns only what is specific to this
app — the constraints that are load-bearing and expensive to rediscover.

Start with `apps/tedi-runtime/README.md`, `src/do.ts`, and the adjacent module
that owns the behavior being changed. `packages/context-core` owns shared
cognition primitives; workstation leases are additive compute.

## This app is the runtime kernel

Every tedi runs here. `AgentTediDO extends Agent` with native Pi cognitive facets is the one
Agent runtime, and a bug in it is a bug in every tedi at once. Hold changes
to a higher bar than app or UI code, in three specific ways:

- **A `do.ts` diff gets read line by line.** Not the file — the diff. That is
  the only review promise that scales here.
- **Split a large change by concern.** Separate commits at minimum, so the
  runtime change can be reviewed apart from its callers and its tests.
- **Fewer kernel lines is the goal, not more.** A change that adds surface to
  `do.ts` should say in its commit message why it could not live beside it.

## `do.ts` is the least reviewable file in the app

One class with many inline `tool({ ... })` definitions and imports, far larger
than any other file in the app. New runtime surface belongs in a module beside
it, not inside it — as a design habit, not a line-count ceiling. The rest of
the app is well decomposed, and the parent DO's real job — tool gatekeeper and
ledger — is much smaller than its size implies.

- **Do not add a new inline `tool({...})` literal to `do.ts`.** Put it in a
  module and import it.
- **Do not attempt a big-bang split.** The parent mediates the scoped `TediComputerWorkspaceDO`
  capability, budget, dedup and ledger authority; moving those responsibilities
  requires an explicit authority and persistence migration. `conversation-facet.ts` proves the seam works for conversations; it
  is not proven for the parent's budget, dedup and ledger mediation.
- Migrating one self-contained domain (browser or email — **not** workspace)
  through the existing facet tool proxy is the shape of a real reduction.

## Invariants that fail silently

None of these announce themselves when broken.

- **Every Worker Loader manifest sets `globalOutbound`.** Absence means _inherit
  the parent Worker's network_, which is the most permissive option and the one
  you get by forgetting. `scripts/lint-loader-sandbox.ts` enforces this repo-wide
  and holds the known gaps; `durable-codemode.ts` is this app's call site.
- **External text goes through `wrapUntrustedInput`** (`src/untrusted-input.ts`).
  The fence markers are derivable from the source name, so the wrapper
  neutralizes them inside the payload — visibly, so an operator reading the
  ledger sees the attempt. Never hand-roll the fence at a call site. The in-message
  handling instructions were deliberately removed because Azure's injection filter
  false-positived on them and the policy moved to `AGENT_RUNTIME_PROMPT`, which
  makes the delimiter the only structural boundary left.
- **Code Mode `execute` writes the tedi's live workspace.** `cm-execution-gate.ts`
  is the gate: session grants in durable KV with a mandatory TTL, legacy
  perpetual entries treated as already expired, approval replay via a one-shot
  grant keyed to session plus code hash, and fail-closed on any read error or
  malformed entry. Do not add a second path to `execute`.
- **Per-tool delegation permission checks exist only for a turn that carries an
  earned grant.** The envelope on a Home delegation is the entrustment Home
  matched at dispatch (`selectDelegationAuthorityEnvelope` in `apps/api`). A
  facet tool call on such a turn is evaluated against it
  (`src/delegation-authority.ts`) and the verdict is recorded as
  `delegation.authority.evaluated` — shadow records `wouldHaveDenied`,
  enforce denies. A delegation with **no** envelope was authorized by Home's
  dispatch decision (operator-forced, approved, or autonomous); its ceiling is `supervisedDelegationToolSet` and it is
  evaluated and logged by nothing per tool. `delegatedTurnAuthority` is the
  one place that decides which case a turn is. Do not reintroduce an
  envelope-less "would have denied" verdict: enforce mode refuses such a run at
  dispatch policy and at runtime ingress (403) before any tool call, so that
  verdict mirrors no enforcement that can happen and only logs unowned rows.
  The default mode stays `shadow`
  and `src/delegation-authority.test.ts` pins it so a silent flip fails tests.
- **Observational ledger writes are durable-first, not awaited to the API.**
  `step.completed`, `tool.started` / `tool.completed` / `tool.failed` and
  `delegation.authority.evaluated` go through `RuntimeEventOutbox.publish`
  (`src/runtime-event-outbox.ts`): a DO-storage put, then a background write
  with a scheduled redrive. Awaiting each write cost about a second, and several
  ran sequentially between two model rounds. Two
  things keep this honest and both fail silently if you skip them. (1) Reads
  order by `createdAt`, which is stamped when the event is built — never
  reorder an event's construction away from the moment it describes. (2)
  **A new terminal-event path must call `eventOutbox.flush(runId)` first.**
  The kernel reconstructs a delegated child's answer from its `tool.completed`
  rows the moment it sees `run.completed`
  (`apps/api/src/rpc/routers/kernel/child-run-reads.ts`), so
  "`run.completed` is visible" must keep implying "this run's observational
  rows are visible". `onLedgerMirror` and `mirrorFailedTurn` already drain.
  Mandatory budget accounting, admission and cancellation are NOT in this lane
  and stay awaited — do not move an enforcement call into the outbox to make a
  stopwatch faster.
- **`MAX_CHAT_STEPS = 40`** (`src/do.ts`) is the backstop for an explicitly
  governed step ceiling, not a default turn cap. A turn with no positive
  `maxIterationsPerTask` has no implicit Pi round ceiling and remains
  bounded by wall clock, organization admission, and context safety.

## Validation

`test:run` iterates `src/*.test.ts` with
`bun run <file>`, using `node:assert`. Run the individual file you touched
first — the loop stops at the first failure, so one unrelated red test hides
every result after it.

`test:workers` runs the isolated native Pi recovery and boundary suites under Vitest/workerd;
`type-check:workers` checks its fixture. Run both when changing Pi lifecycle,
accounting, recovery, or cancellation behavior. The fixture uses local DO storage
and scripted model responses, with no production bindings.

Never use bare `bun test` here; it ignores the Workers aliases.
