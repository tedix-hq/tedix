---
summary: "The Agent runtime for tedis: facets, step ceilings, Computer, recovery, cron limits, inference guardrails, and model selection"
read_when:
  - Updating apps/tedi-runtime or Agent runtime behavior
  - Understanding the Agent runtime relative to a workstation lease
  - Resolving a tedi's chat model or deciding whether a task needs a workstation
title: "Tedi Agent runtime"
---

# Tedi Agent Runtime

`apps/tedi-runtime` is the one tedi runtime: `AgentTediDO extends Agent`
(Cloudflare Agents) with native Pi Durable cognitive facets. Long-lived
OS/process capability attaches through a workstation lease, never a runtime
swap ([workstations-over-bodies](../../../decisions/workstations-over-bodies.md)).
Scoped rules and silent invariants (`do.ts` containment, `globalOutbound`,
untrusted input, the event outbox, inert receivers) are in
`apps/tedi-runtime/AGENTS.md`; the platform/runtime split is in
[cognition/runtime.md](../cognition/runtime.md).

The runtime reaches `apps/api` through a service binding that grants no
procedure permissions: it delegates only `TEDI_RUNTIME_API_SCOPES` in
`X-Tedix-Tedi-Scopes`, and missing delegation fails closed.

## Facets

| Facet                   | Runs                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `ConversationFacet`     | MCP `run_tedi_turn`, embedded streaming, email, `ChatTurnWorkflow` |
| `JudgeSessionFacet`     | Blind verification turns (no tools)                                |
| `SynthesisSessionFacet` | `workflow:synth:*` turns (no tools)                                |

Each facet is a colocated child DO with its own Pi conversation and submission
queue (`src/pi-agent.ts`). Pi owns generation, tool tasks, and checkpoint
recovery; the parent owns identity, D1 settlement, events, cognitive context,
and the per-run tool proxy registry. Parent authority is rechecked at actual
dispatch, including after recovery; a prior Pi hook is not continuing
permission. Stored legacy history is imported passively with stable ids and is
never submitted as new requests. Tedix's D1 ledger, not Pi storage, is the
canonical transcript.

### Step ceilings

`maxSteps` is opt-in. A ceiling exists only when governance stamps a positive
`maxIterationsPerTask` (`resolveGovernedStepCeiling`); `MAX_CHAT_STEPS` only
clamps it. Ungoverned turns are bounded by wall clock, budget, and compaction.
Wake (`WAKE_TURN_MAX_STEPS`) and cron (`CRON_TURN_MAX_STEPS`) turns take the
minimum of their own and the governed ceiling. The final round of any ceiling
is reserved for a tool-free synthesis; `budget_exhausted` and `step_ceiling`
stops are partial results that need continuation, never clean completion.

### Why native SDK pieces are wrapped

- Workers AI goes through `@tedix/workers-ai`: the Agents native provider needs
  an AI binding and has no dispatch-authorization hook, so replacing the
  adapter would lose the HTTPS transport and admission.
- Browser tools use the Agents browser composer, but Tedix keeps the combined
  org/tedi allow-and-deny policy, budget, and takeover authority; native
  allow-only guards cannot express that intersection.
- Computer's Git help is exposed through the governed repository tool; help
  does not authorize the network commands it describes.

## Computer and Tool Ledger

Native Computer files and `exec` cover scratch work. For installed software,
tests, builds, or repositories the model calls `open_computer` (coding
delegations use `open_computer({ repository: true })`); the host picks and
reuses a Linux environment. Long commands detach and their completion arrives
as a new turn, so the model never polls (`read_execution`, `cancel_execution`,
`close_computer`).

Every Computer call is a `tool.started` / `tool.completed` ledger row
(`src/native-tool-ledger.ts`) keyed by tool-call id and sequenced from a
wall-clock cursor, so a mid-turn eviction cannot reissue ids. `resultPreview`
is bounded and redacted and cannot imply success or persistence; only the
receipt can. Terminal workstation process logs are indexed as `tedi_artifacts`
rows (`workstation_process/<processId>/<file>`).

Streaming emits `message.phase` transitions and `tool_input` progress frames
carrying only `{ toolCallId, chars }`; the widget shows a tenant-authored
activity label (`app_tools.invocation_status`), never callable names.

## MCP Turns

MCP `run_tedi_turn` and inject always dispatch a workflow and acknowledge once
the queued event is readable. Retry with the same `client_request_id`; a
dispatch failure keeps the run identity and never falls back to a second inline
execution. Durable Code Mode lives in `AgentTediDO`, not the stateless MCP
gateway, because state, approval, and replay must belong to one tedi identity
([codemode.md](../mcp/codemode.md)).

## Recovery

- Workflow retries are for recoverable failures only; tool failure, exhausted
  ceilings, and stopped runs return typed terminal failures.
- Each recovery rechecks parent admission, budget class, and the cancellation
  tombstone; every provider dispatch rechecks cancellation.
- A delegated facet fails only when its heartbeat is rejected **and** a fresh
  read confirms the Attempt is terminal.
- A missing parent tool registry returns `facet_tool_unavailable` rather than
  answering without tools.

Facet accounting journals each provider attempt before dispatch and its usage
receipt before reconciling the budget, keyed by run and attempt so retries do
not double-debit; missing usage is unknown, not zero. Before a mutating tool
runs, its call id is journaled as an effect fence
(`src/facet-dispatch-journal.ts`). A fence without a terminal marker blocks
recovery (`Interrupted tool effects require reconciliation before recovery`);
the model is told to inspect state rather than replay. Read-only tools create
no fence.

**Non-guarantees.** The journal is local accounting, not D1 settlement or
provider idempotency; fences prevent automatic replay but do not make external
effects atomic.

Test lane: `bun run --cwd apps/tedi-runtime test:workers` (real DO resets with
scripted providers).

## Protocol Surface

| Route                 | Purpose                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `/acp`                | Pi chat WebSocket (`agents/chat` frames)                                  |
| `/mcp`                | Streamable HTTP MCP (`src/mcp-mount.ts`)                                  |
| `/chat/capn`          | Embedded Cap'n Web root; capability pinned to tenant, origin, user, convo |
| `/__admin/agent-diag` | Service-binding diagnostics                                               |
| `/__admin/schedules`  | Read-only Agents-SDK schedules (skill schedules live in D1)               |

`apps/tedi` keeps the public host, auth, and admin API stable and routes here.
The widget authenticates a short-lived signed token inside `/chat/capn`; each
capability revalidates per operation. Reconnect resumes from the last delivered
event id and never retries turn creation or starts a replacement run. Attached
org capabilities and artifact pins are injected as untrusted context and never
expand tools, scopes, or FGA.

Telegram persists the authenticated event before execution and reply intent
before external send; an uncertain send is fenced for reconciliation, not
resent.

## Cron

Every cron fire is a full agent turn and the `cron` tool is model-reachable, so
`add` is bounded mechanically in `src/cron.ts`: a one-minute recurring floor,
no seconds-field expressions, `MAX_SCHEDULED_JOBS` per tedi, and an expiry on
recurring tool jobs (renewal is a named re-add). Policy-pack template jobs are
reconciled from D1 and never expire.

- `cronPolicy.protectedCronNames` lists jobs the tool may not remove; the check
  fails closed.
- Rebinding a tedi to a fresh DO does not cancel the old DO's alarms;
  `isOrphanedIsolateDo` makes a proven orphan cancel its own schedules (lookup
  errors fire normally).
- A failed policy read authorizes neither additions nor removals.
- Every named fire stamps `tedi_cron_executions` below the tool surface.
- Skill schedules live in D1 `skill_schedules`, dispatched by
  `dispatchDueSkillSchedules` in `apps/api`. The same loop can exist both as a
  DO alarm and a skill schedule; retiring one means checking both.

A fire refused for budget or billing is terminal, not retryable: the DO stores
`cronBudgetSuppression` and skips fires until the next UTC day or freed
capacity; skill schedules record `budget_blocked`.

## Inference Guardrails

Spend is bounded below the prompt layer; instructions and tools cannot override
it.

| Guard              | Enforcement                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Daily tokens/turns | Reserved atomically in the parent DO before a provider call (`src/inference-budget-store-do.ts`)     |
| Reserve lanes      | Background work stops first; operator turns may use the full ceiling (`src/inference-guardrails.ts`) |
| Entitlement        | `runtimeEntitlements.authorizeInference`; missing `TEDIX_BILLING_SETTLEMENT_MODE` fails closed       |
| Request size       | Bodies over `TEDI_MAX_AI_REQUEST_BYTES` fail before the gateway fetch                                |
| Context growth     | Native Pi compaction; provider overflow enters `CompactionTask` recovery (`src/context-overflow.ts`) |
| Delegated context  | Cron sees only Code Mode; Home-delegated children get an execution-only surface                      |
| Attribution        | `cf-aig-metadata` carries tedi, org, and a server-derived `source` (`tedi_call_costs.source`)        |

Per-tedi daily limits default to `-1` (shared org capacity); zero denies.
Admission uses a character estimate, so one request can settle above the
remaining budget; the request-size ceiling bounds the overrun.

## Model Selection

Default is `cloudflare/auto`; fixed refs are governed exceptions. Resolution
(`getModelPolicy`, `apps/api/src/rpc/routers/tedis/config.ts`): per-tedi
override (`apps/api/src/lib/tedi-model-overrides.ts`, unknown refs fall
through), then `runtime_profiles.config.modelPolicy.chatModelRef`, then
`cloudflare/auto`. Auto Router candidates are narrowed by deployment vars
`AI_GATEWAY_AUTO_ALLOWED_PROVIDERS` / `_MODELS`. Provider errors stay errors:
nothing silently switches providers. Home/kernel uses `KERNEL_MODEL_REF`. There
is no per-user model preference. `modelCatalog.list` (MCP `list_models`)
explains per model which filter allowed or denied it; inputs with no backing
store report `not_configured` or `unknown`, never `allow`.

## Workstations and Certification

Attach a workstation only for a concrete OS/process need (long-lived shell,
browser/CDP beyond a request, native dependencies, ports, dev servers) and
release it when done. Prefer one workstation with several tedi seats over
several leases.

The Agent runtime is the only certified runtime (`AGENT_FACET_MANIFEST` in
`packages/api-contract/src/schemas/body-certification.ts`; `assertCertifiable`
requires smoke, MCP validation, eval run, and trace bundle proof refs). A
second runtime starts by filling a manifest, not as a spike. A manifest is not
proof of what is deployed.

Never collapse runtime health into one "running" claim: D1 config, public
status, diagnostics, MCP tool use, OS chat, and session readback each prove a
different thing.
