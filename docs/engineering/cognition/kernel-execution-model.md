---
summary: "Kernel execution model: pure-router dispatch, delegation to tedis, approved writes, cancel, and wake-back"
read_when:
  - Changing Home/kernel turns, delegation, or approved writes
  - Adding concurrency, raising limits, or changing delegation autonomy
  - Deciding whether something belongs in the kernel or a tedi
title: "Kernel execution model"
---

# Kernel Execution Model

The kernel is a pure router and answerer; it never calls provider tools. Every
live-data read, owned write, and multi-step task is delegated to a tedi with
its own identity, memory, and skills. Rationale:
[agentic-kernel-architecture](../../../decisions/agentic-kernel-architecture.md).

`KernelDOv4` (`apps/api/src/kernel/kernel-do.ts`), one per org via
`idFromName(organizationId)`, runs Home turns. Home is a non-blocking
multiplexer: each turn gets one parent `homeRunId`, delegated work runs
concurrently, and results stream back as they settle.

## Turn Lifecycle

`kernelRuntime.enqueueMessage` persists the user turn, `run.started`, and the
run row, then races `KernelDOv4.processTurn` against a short handler budget:
fast turns return inline, slower ones return an ack with a
`task: { pollWith: "tasks/get" }` handle.

- Home answers use two metered calls: a schema-valid route decision, then a
  tool-free answer stream after the guard selects `answer_in_home`. Only the
  second emits deltas; failed or incomplete output cannot settle as success.
- The terminal patch is conditional (`WHERE status='running'`), so cancel or
  duplicate execution cannot overwrite a terminal state.
- `turn-work.ts` receives dependencies through `KernelTurnWorkDeps` and must not
  import `kernel-runtime.ts` (import cycle).
- The run row's `metadata.kernelRoute` holds the full route decision
  (`routerVersion`, harness version, trace bundle id); `run.completed` carries
  only a compact snapshot with no answer text or tool args.

## Delegation

- **Auto-dispatch is fail-closed per tedi** (`decideDelegationDispatch`): `auto`
  only when the capability card is running, `requiresApproval` is false, scopes
  are non-empty, risk is not high, and the speaker holds `approvalAuthority`.
  Otherwise an approval card. No global override promotes `needs_approval`
  ([agent-capability-mutation-gate](../../../decisions/agent-capability-mutation-gate.md)).
- **Children inherit nothing implicit**: only the rendered work order, a
  deterministic idempotency key, and bounded metadata. Never the parent's
  credentials, scopes, tool bindings, or memory; the child hydrates its own.
  Work-order budget caps are advisory; the child's profile budgets apply.
- **Work Items only on explicit intent** (`delegation-intent.ts`). A
  router-decided delegation of a plain question runs a supervised child without
  a board item.
- **Approvals inside a child**: a Code Mode pause emits `approval.requested`,
  the Home run stays `requires_approval`, and the Home card resumes or rejects
  the exact recorded call.
- Limits: `KERNEL_MAX_PLAN_OWNERS`, `KERNEL_MAX_DELEGATIONS`
  (`apps/api/wrangler.jsonc`).

Result delivery:

- **Relay first.** The child's final message is relayed verbatim; LLM synthesis
  is a fallback only for multi-child wakes or children with tool results but no
  final message.
- **Idempotent repair.** A terminal Home run row is enough to (re)write the
  completion message under a deterministic event id
  (`recordHomeDelegationCompletionMessage`).
- **Disposition.** No substantive result settles `failed`; `budget_exhausted` or
  `step_ceiling` projects `partial` ("needs continuation") and does not complete
  the Work Item. Code Mode work counts as verified only with a successful
  `completionEvidence` receipt.
- **Output schema (opt-in).** `buildDelegationWorkOrder({ outputSchema })` asks
  for a fenced JSON block; a structural validator appends
  `[OUTPUT CONTRACT NOT MET: ...]` but never hides the child's answer.

## Approved Writes

`propose_tool_write` stores one exact write call on a deterministic approval
row (`kind: home_tool_write`), parks the run `requires_approval`, and executes
the stored call exactly once on approve (approval latch plus conditional run
claim). `tediApprovals.resolve` and `respond_home_approval` share that path.

Write risk is fail-closed: low only when the provider says
`destructiveHint: false` and the name has no destructive verb. Ambiguous hints
are high risk and cannot use a wildcard approval. Tenant
`mcpConfig.toolParamDefaults` override model-invented args.

MCP calls on the kernel's behalf carry `X-Tedix-Kernel: true`, honored only from
authenticated service-binding callers and recorded as `actorType: "kernel"`.

## Operator Cancel

`cancel_home_run` is honored before dispatch (re-read status), before
materializing (write a cancel marker, skip the terminal patch), in flight (a
run-keyed `AbortController`; an operator abort never trips a breaker or
fallback), and at child reconcile (stop live children of a canceled parent).
The Agent runtime records a cancellation tombstone before terminating its
Workflow, so a cancel that beats Workflow creation still wins.

## Wake-Back and Recovery

Terminal child notifications go to `kernel_wake_queue` with a short debounce
(`KERNEL_INBOX_WAKE_DELAY_MS`). Wakes arrive via the queue, alarms, cold-start
re-arm, and a reconciliation sweep. The first three are armed by a child event,
so a child that never started is caught only by on-read reconcile and the
sweep, which is why dispatch is awaited in-band, not left to `waitUntil`.

Backstops: a per-turn stall watchdog (`failStuckTurn`, status-guarded),
`reconcileRuns` while non-terminal Home runs exist, and
`reconcileStaleSubmissions` for interrupted reserve/finalize. Wake delivery is
deferred during an active turn.

**Non-guarantees.** The wake delay is a debounce target, not an SLA. Alarm paths
are fail-soft; a quiet org repairs on the next turn, cold activation, or
run-set read. Live streams are hints; run-set and history reads are the record.
Diagnose latency from `home-run-trace.v1.latency`, not a client spinner, and
measure time to first update separately from time to final answer (a
multi-tedi plan waits for every required branch).

## Memory and Context

The kernel assembles org-wide facts only (`memory_facts.tedi_id IS NULL`); each
tedi assembles its own. A delegated child skips compiled directives so the work
order stays the governing instruction. History is bounded by token pressure,
not turn count: past `COMPACTION_TRIGGER_RATIO` the oldest turns fold into one
checkpoint (`@tedix/context-core/compaction-boundary`), and a provider overflow
triggers one refold at half budget. The D1 ledger is never modified.
