---
summary: "Kernel execution model: pure-router dispatch, delegation to tedis, cancel, wake-back, and coordination latency"
read_when:
  - Grounding work in how the kernel executes — who does what, where
  - Designing features that add concurrency, raise limits, or change delegation autonomy
  - Separating time to first progress from time to final plan convergence
  - Deciding whether something belongs in the kernel or a tedi
title: "Kernel execution model"
---

# Kernel Execution Model

The kernel is a pure router and answerer. It never calls provider tools. Every
live-data read, owned write, and multi-step task is delegated to a tedi that
has its own identity, memory, skills, and Agent-runtime body. The design
rationale is [agentic-kernel-architecture](../../../decisions/agentic-kernel-architecture.md).

The Home conversation is a non-blocking multiplexer: an operator can ask many
things, each turn gets one parent `homeRunId`, delegated work runs
concurrently, and results stream back as they settle. It is the async-subagent
pattern, except the workers are long-lived tedis whose memory accumulates.

## Who Does What

| Layer  | Runner                                                         | Role                                                       | Memory                                |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| Kernel | `KernelDOv4` (`apps/api/src/kernel/kernel-do.ts`), one per org | Route, answer inline, propose a write, or delegate         | Org-wide facts + conversation history |
| Tedi   | Agent runtime ([agent-runtime.md](../tedi/agent-runtime.md))   | Full Pi loop with skills and MCP tools; runs all tool work | Per-tedi brain + skills               |

`KernelDOv4` extends `AIChatAgent` (without a free tool loop) and is bound as `KERNEL`, addressed
by `idFromName(organizationId)`. Kernel code lives in `apps/api/src/kernel/` and
`apps/api/src/rpc/routers/kernel/`.

## Turn Lifecycle

`kernelRuntime.enqueueMessage` persists the user turn, `run.started`, and the
run row first, then hands the turn to `KernelDOv4.processTurn`. The API races
the DO turn against the remainder of a short handler budget: fast turns return
inline; slower turns return an ack with the `homeRunId` and a
`task: { id, pollWith: "tasks/get" }` handle while the DO continues. A DO-stub
failure falls back to the inline path.

The turn body (`turn-work.ts`) runs the route planner inline. Auto Router
Home answers use two metered calls: a complete, schema-valid route decision
with a short answer outline, then a tool-free plain-text answer stream after
the deterministic guard selects `answer_in_home`. Only the second call emits
answer deltas; its completed text becomes the durable answer. Both calls retain
usage and execution receipts. Cancellation stops the answer stream, and failed
or incomplete output cannot settle as a successful answer. Routing and
action acknowledgements retain their existing validation and authority gates.
Context assembly (`context-assembly.ts`) starts memory recall on DO entry and
waits a bounded time before proceeding with static facts. The terminal patch is
conditional (`WHERE status='running'`), so a cancel or duplicate execution
cannot overwrite a terminal state. `turn-work.ts` receives its dependencies
through `KernelTurnWorkDeps` and must not import `kernel-runtime.ts` back
(that would close an import cycle).

Every successful route decision carries `routerVersion` (`router-version.ts`),
a harness version id, and a trace bundle id; the full decision lives on the run
row as `metadata.kernelRoute`. The `run.completed` payload is a compact route
snapshot — no answer text, tool args, or message bodies.

## Delegation

- **Fan-out.** The plan path (`plan-planner.ts`) decomposes a multi-target
  request into per-owner objectives, parks them for `approve_home_plan`, and on
  approval dispatches each child run independently.
- **Auto-dispatch.** `decideDelegationDispatch` (`delegation-dispatch.ts`) is
  fail-closed per tedi. It returns `auto` only when the tedi's capability card
  is present and running, `requiresApproval` is false, scopes are non-empty,
  risk is not high, and the speaker holds `approvalAuthority` (a human org
  member). Otherwise the operator sees an approval card. There is no global
  override that promotes `needs_approval` verdicts; see
  [agent-capability-mutation-gate](../../../decisions/agent-capability-mutation-gate.md).
- **Children inherit nothing implicit.** The dispatch carries only the rendered
  work order, a deterministic idempotency key, and bounded metadata (parent
  ids, optional budget caps). Never the parent's credentials, scopes, tool
  bindings, or memory. The enqueue runs under an internal service-binding
  identity scoped to the target org (`kernel-runtime.ts` `enqueueChild`), and
  the child hydrates its own identity, capabilities, skills, and memory.
  Work-order budget caps are advisory metadata; the child's own profile budgets
  always apply.
- **Work Items only on explicit intent.** A governed Work Item is minted only
  when the message carried explicit delegation intent (`delegation-intent.ts`).
  A router-decided delegation of a plain question dispatches a supervised child
  run without a board item.
- **Approvals inside a child.** A delegated tedi may pause Code Mode on an
  approval-required connector call. The child emits `approval.requested`, the
  Home run stays `requires_approval`, and the Home approval card resumes or
  rejects the exact recorded call (`apps/tedi-runtime/src/durable-codemode-lifecycle.ts`).

Limits come from `apps/api/wrangler.jsonc` vars: `KERNEL_MAX_PLAN_OWNERS`
(owners in the plan prompt) and `KERNEL_MAX_DELEGATIONS` (per-turn fan-out).

### Result delivery

- **Relay first.** The child's final assistant message is the return value; the
  parent's completion message carries it verbatim. A bounded LLM synthesis
  pass is the fallback only for multi-child wakes and for children that
  finished with tool results but no final message.
- **Idempotent repair.** A terminal Home run row is enough to (re)write the
  completion message under a deterministic event id
  (`run-store.ts` `recordHomeDelegationCompletionMessage`), so a failed insert
  cannot permanently swallow a result.
- **Retrying reads.** Transient remote-D1 transport errors
  (`runtime-shared.ts` `isRemoteD1TransportError`) are retried on a bounded
  budget in `child-run-reads.ts`; other errors propagate.
- **Settlement disposition.** A delegated run that completes with no
  substantive result (no `message.completed`, no artifact, no preview) settles
  as `failed`. A `run.completed` carrying `budget_exhausted` or `step_ceiling`
  projects as `partial`: Home stops the spinner, shows "needs continuation",
  and does not complete the Work Item. Code Mode work counts as verified only
  with a successful `completionEvidence` receipt.
- **Metadata, not prose.** Delegation verdicts ride as `metadata.delegationProof`
  (see [runtime.md](runtime.md#home-live-events)).

### Output schema (opt-in)

A caller may pass `outputSchema` to `buildDelegationWorkOrder`. The work order
then asks the child for a fenced `json` block, and at relay time
`output-schema-validate.ts` checks it with a minimal structural validator
(`type`, `required`, `properties`, `enum`, `items`). Failure appends an
`[OUTPUT CONTRACT NOT MET: ...]` note after the relayed content; it never
hides the child's answer. The route planner does not set `outputSchema` itself.

## Approved Writes

`propose_tool_write` plans one concrete write call over the provider's
write-capable catalog, stores that exact call on a deterministic approval row
(`kind: home_tool_write`, `write-executor.ts`), parks the run
`requires_approval`, and emits `approval.requested`. Approve executes the
stored call exactly once (approval latch + conditional run claim); reject or
cancel closes the run unexecuted. `tediApprovals.resolve` and
`respond_home_approval` share the same latch-and-settle path. A declined
proposal records `kernelWriteProposalDeclined` with a stage and detail.

Write-risk classification is fail-closed: a tool is low risk only when the
provider supplies `destructiveHint: false` and its name has no destructive
verb. Missing or ambiguous hints are high risk and cannot use a wildcard
approval. Tenant `mcpConfig.toolParamDefaults` override model-invented args on
both write proposals and delegated reads.

Tenant catalog installation is a first-class Home write. Context assembly
projects the narrow `catalog.install` capability from a Code Mode gateway that
holds `mcp:catalog.write`; the planner uses the tenant batch installer for
multiple product names, while server-owned defaults pin execution to the
current gateway and disable dry-run. Each prepared app installs independently,
and an unprepared or unmatched entry returns a per-app blocker instead of
turning the whole request into a generic clarification. Organization onboarding
provisions its default tedi before the unified gateway so the approval row and
gateway assignment are immediately valid.
Because `catalog.install` has one canonical batch primitive (which also accepts
a single query), write planning selects it directly after discovery instead of
asking action selection to distinguish it from neighboring catalog-maintenance
tools. Exact-schema argument construction and human approval remain unchanged.

MCP calls made on behalf of the kernel carry `X-Tedix-Kernel: true`, which
`validateAuth` (`apps/mcp/src/auth-helpers.ts`) honors only from authenticated
service-binding callers and records as `actorType: "kernel"`.

## Operator Cancel

`cancel_home_run` is honored at four points (`turn-work.ts`, `run-store.ts`,
`kernel-do.ts`):

1. **Before dispatch** — the run status is re-read; a canceled run spawns nothing.
2. **Before materializing** — a canceled turn writes a short marker ("Turn
   canceled — …") as its completion content, settles the submission as
   `canceled`, and skips the terminal patch and title generation. If a
   dispatch raced the cancel, the child link is persisted and the child is
   stopped.
3. **In-flight LLM** — `KernelDOv4` keeps a run-keyed `AbortController`;
   `cancelTurn(runId)` aborts it after the run row is marked canceled. The
   signal reaches every provider path in `route-planner.ts`. An operator abort
   is never recorded as a provider failure and never trips a breaker or
   fallback. A missing controller is a normal no-op.
4. **Child reconcile** — run-set reconcile stops a still-live child of a
   canceled parent through the same child-stop RPC. The Agent runtime records a
   cancellation tombstone before terminating its Workflow, so a cancel that
   arrives before the Workflow exists cannot later complete.

## Wake-Back and Recovery

Terminal child notifications are persisted to `kernel_wake_queue` and
delivered with a short debounce (`KERNEL_INBOX_WAKE_DELAY_MS`, clamped to
100–5,000 ms). Four paths deliver a wake: the persisted queue, direct alarm
scheduling, cold-start re-arm (`inbox-wake-recovery.ts`), and a periodic
reconciliation sweep. The first three are armed by a child event, so a child
that never started is caught only by on-read reconcile and the sweep — which
is why dispatch is awaited in-band rather than left to `waitUntil`.

For a direct delegation, the deterministic parent `message.completed` event is
the delivery record; on-read reconcile and the wake path converge on the same
event id. Multi-tedi plans post one `plan-convergence` message after all
required branches settle.

| Mechanism               | Behavior                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Per-turn stall watchdog | `failStuckTurn` alarm; status-guarded D1 update so a finished or parked turn is not failed             |
| Reconciliation sweep    | `reconcileRuns` alarm while non-terminal Home runs exist; repairs missed settlement, expiry, and relay |
| Reserved-latch recovery | `reconcileStaleSubmissions` replays an interrupted reserve/finalize from the recorded outcome          |
| Child-completion wake   | Deferred during an active turn; `onTurnEnded` schedules the wake, which runs in the same org DO        |

**Non-guarantees.** The wake delay is a debounce target, not an SLA; alarm
scheduling, contention, and synthesis can make a hop longer. Alarm paths are
fail-soft: a failed schedule or a quiet org does not promise timed recovery —
the next Home turn, cold DO activation, or a run-set read triggers repair.
Live streams to Tedix OS are delivery hints; run-set and history reads are the
record and fill gaps.

## Coordination Latency

Measure two boundaries separately:

- **Time to first meaningful update** — acknowledgement, route, work card, or
  branch progress. Independent branches update concurrently.
- **Time to final answer** — every required branch is terminal, Home has
  processed its wake, and the parent has persisted one synthesis. A multi-tedi
  plan deliberately waits for all required branches.

Diagnose tail latency from `home-run-trace.v1.latency` timestamps, not from a
client spinner.

## Memory and Context

The kernel assembles org-wide facts only (`memory_facts.tedi_id IS NULL`);
each delegated tedi assembles its own personal facts in its runtime. For a
Home delegation work order, the child keeps identity, skill guidance, and its
brain digest but skips compiled directives, so the work order stays the
governing instruction.

Conversation history is bounded by token pressure, not turn count: turns replay
verbatim until the prompt crosses `COMPACTION_TRIGGER_RATIO` of the model's
budget, then the oldest turns fold into one checkpoint message
(`@tedix/context-core/compaction-boundary`). A provider context-overflow error
triggers one refold at half the budget. The D1 ledger is never modified, and a
conversation cannot read another conversation's history.

## Related

- [agent-runtime.md](../tedi/agent-runtime.md) — the runtime that executes delegated turns
- [work-items.md](work-items.md) — Work Items, Attempts, and delegation dispatch
- [brain.md](brain.md) — tedi memory
- [../product/tedix-os.md](../product/tedix-os.md) — work cards and the multiplexing client
