---
summary: "The Agent runtime for tedis: facet execution, step ceilings, recovery, cron limits, inference guardrails, model selection, and runtime certification"
read_when:
  - Updating apps/tedi-runtime or Agent runtime behavior
  - Understanding the Agent runtime relative to a workstation lease
  - Reviewing runtime-neutral versus runtime-specific ownership
  - Resolving a tedi's chat model or deciding whether a task needs a workstation
title: "Tedi Agent runtime"
---

# Tedi Agent Runtime

`apps/tedi-runtime` is the one tedi runtime, built on Cloudflare Agents and native Pi Durable
(`AgentTediDO extends Agent`; the cognitive facets extend `PiAgent`). Its runtime label is `agent`. Long-lived
OS/process capability attaches through a workstation lease, never a runtime
swap. The platform/runtime split is owned by
[cognition/runtime.md § Runtime Boundary](../cognition/runtime.md#runtime-boundary).

## What It Owns

- The native Pi loop, tedi identity, MCP endpoint, and runtime auth surface.
- Scoped Cloudflare Computer workspaces on Durable Object SQLite, with native
  `read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, and `exec` tools
  narrowed by turn permissions. Generated Workers receive only the
  workspace-scoped `WorkspaceServiceProxy`.
- Session reads/writes through `@tedix/tedi-session`.
- Ledger events, the brain and rationale bridges, and trace bundle hooks.
- The Code Mode facet with its approval/replay lifecycle. The generated
  Worker is disposable; the facet owns the execution log. Returned and ledger
  projections are bounded and secret-redacted.
- Email, voice-note, browser-call, MCP, approval, schedule, and stop/cancel
  paths declared by `AGENT_FACET_MANIFEST`.

It does not own arbitrary shell processes, repo checkouts, native dependencies,
dev servers, or persistent CDP sessions — those need a workstation
([workstations-over-bodies](../decisions/workstations-over-bodies.md)).

### Ownership boundaries

- **Runtime-neutral:** D1 control-plane rows, identity, FGA, MCP app
  assignments, brain writes, rationale, Work Items, sessions, artifact
  metadata, policy packs, runtime profiles, certification results.
- **Agent-runtime-specific:** Pi behavior, the Computer workspace, the
  ledger mirror, tool adapters, channel handling that fits Worker limits,
  replay/eviction behavior.
- **Workstation-specific:** shell/process execution, dev-server tunnels, repo
  checkout, native dependencies, browser/CDP sessions, multi-tedi seats.

The runtime reaches `apps/api` through a service binding. The binding
authenticates transport but grants no procedure permissions: the runtime
delegates only `TEDI_RUNTIME_API_SCOPES` (`tedis:read`, `tedis:write`,
`billing:read`) in `X-Tedix-Tedi-Scopes`. Missing delegation fails closed.

## Cold parent identity discovery

When the parent lacks a cached or hinted owner, `runtime-parent-identity.ts`
looks up its actual Agent name through the owning D1 query. The effective
physical name is `COALESCE(isolate_agent_id, slug)`: the supported null-name
representation continues to route through the slug. A rebound canonical name
does not authorize the old slug-named object. One SQL snapshot rejects duplicate
effective names; the helper validates the tedi/organization UUIDs, `agent`
runtime, original namespace-derived physical ID and root path. It pins local
name, facet, tenant and configuration facts before the query and refuses changes
after the await. Discovery neither writes owner metadata nor initializes admission.

This is a bounded discovery read window. Cached/header-hinted identity paths,
SDK recovery before user startup, and later R2/governance awaits remain outside
this helper. D1 and Durable Object state are not one atomic transaction. Peer
and administrator identity resolution retains its existing slug/ID lookup.
Local production-class tests exercise this boundary; deployed metadata and
passive inspections do not prove a live object invoked cold discovery.

## Facet Execution

Conversation turns run in Agents SDK sub-agent facets under the parent DO:

| Facet                   | File                             | Runs                                                               |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `ConversationFacet`     | `src/conversation-facet.ts`      | MCP `run_tedi_turn`, embedded streaming, email, `ChatTurnWorkflow` |
| `JudgeSessionFacet`     | `src/judge-session-facet.ts`     | Blind verification turns                                           |
| `SynthesisSessionFacet` | `src/synthesis-session-facet.ts` | Tool-free `workflow:synth:*` turns                                 |

(Session classes: [runtime.md § Special Session Classes](../cognition/runtime.md#special-session-classes).)

Each facet is a colocated child DO with its own native Pi conversation and
submission queue. `src/pi-agent.ts` hosts `agents/harness/pi`; Pi owns generation,
tool tasks and checkpoint recovery. The parent owns identity, D1 settlement,
events, cognitive context and the per-run tool proxy registry. Every provider
dispatch uses `src/pi-model.ts` through Tedix's selected Workers AI/Azure adapter.

Configuration and submission share one gate. Submission IDs are immutable,
answers come from their exact native owned entry, and persisted application
receipts retain turn count, usage and selected model identity. Existing stored
history is imported passively with stable IDs, never submitted as new requests.
Unresolved stored submissions and effects block import.

Pi receives only the parent descriptors. Judge and synthesis facets expose no
tools. Parent authority is checked at actual dispatch, including after recovery;
a prior Pi hook is not continuing permission.

"Facet" here means the runtime primitive, not the product sense of a scoped
tedi projection.

### Step ceilings

`maxSteps` is a provider-round budget and is opt-in:

- A ceiling exists only when governance stamps a positive
  `maxIterationsPerTask` for the tedi (`resolveGovernedStepCeiling`,
  `src/tedi-governance.ts`). Negative or absent means no ceiling.
- `MAX_CHAT_STEPS` (`src/do.ts`) only clamps a stamped ceiling. An ungoverned
  turn has no implicit Pi provider-call cap; it is bounded by wall
  clock, daily budget, and compaction instead.
- Assignment-wake turns (`WAKE_TURN_MAX_STEPS`) and maintenance cron turns
  (`CRON_TURN_MAX_STEPS`, `src/cron-turn-outcome.ts`) take the `Math.min` of
  their own ceiling and the governed one.
- The governed Pi provider bridge reserves the final round of any ceiling for a
  tool-free synthesis. Budget or unsynthesized step stops settle with a
  structured `stopReason` (`budget_exhausted` or `step_ceiling`) and are
  partial results that need continuation, never clean completion.

Each facet model round is mirrored as one `step.completed` event with provider
usage.

### Native SDK boundaries

The root dependency catalog selects the Agents, Pi Durable, Pi AI, Computer and Shell
versions. Upstream features are adopted inside the existing ownership boundaries:

- Computer's native Git command help is exposed through the governed repository
  tool. Help does not authorize the network commands it describes. Workspace
  execution continues through `WorkerShellBackend`; full Linux execution belongs
  to the Sandbox workstation lease. Pi/TanStack adapters and Computer container
  backends do not introduce additional runtime lanes.
- Browser tools use Agents' native browser composer, inheriting CDP discovery
  and socket recovery. Tedix still owns the combined organization/tedi allow and
  deny policies, browser budget and takeover authority. Native allow-only guards
  cannot replace that policy intersection.
- Workers AI calls use `@tedix/workers-ai`, including dispatch admission and
  both binding and authenticated HTTPS transports. Agents' experimental native
  provider requires an AI binding and supplies no dispatch-authorization hook;
  replacing the adapter would lose supported transport and governance contracts.
- Code Mode uses native execution primitives with Tedix-owned consent,
  replay, result and telemetry contracts. The SDK's typed `{ code: string }`
  Standard Schema metadata applies to its `createCodeTool` composer; Tedix's MCP
  registration already declares this input with Zod and needs no duplicate shim.
- Pi owns its native entry graph and recovery. Tedix's D1 ledger remains the
  canonical runtime-neutral transcript. Legacy Agents Sessions storage in Pi facets is kept
  for passive import and administration; it does not drive new inference. The
  parent does not register Sessions or hydrate its history for diagnostics.

See [upstream Computer](https://github.com/cloudflare/computer),
[Code Mode](../mcp/codemode.md) and the
[upstream model provider](https://github.com/cloudflare/agents/blob/agents%400.26.0/docs/agents/models.md)
for the exact supporting contracts.

### Streaming frames

Model selection and the final-step rule live in `src/turn-model-selection.ts`
(default Cloudflare Auto Router or an explicit fixed provider selection).
Provider errors remain errors; no force flag or shared circuit silently changes
providers. Auto Router candidates are narrowed by deployment-owned
`AI_GATEWAY_AUTO_ALLOWED_PROVIDERS` and `AI_GATEWAY_AUTO_ALLOWED_MODELS`.
The production bootstrap pool uses the verified Workers AI billing path;
image requests use the separately proven Gemma/Qwen candidate pool. GPT-6 funding and direct Azure BYOK remain distinct from managed Auto Router eligibility.

During a turn the runtime emits:

For GPT-5.6-and-later Azure turns, the provider preparation in `ConversationFacet` marks only
the parent-owned persona prefix as an explicit provider prompt-cache boundary
(`src/prompt-cache.ts`). The opaque 64-character cache digest is versioned over organization,
tedi, surface, and the exact stable prefix; dynamic MCP instructions, consent,
tool descriptions, and Pi guidance remain outside that boundary. Cache reuse
may therefore cross sessions for the same tedi and surface, but never crosses a
tenant or tedi identity. The request inspector verifies the key, explicit mode,
and breakpoint reached the provider wire without retaining prompt or key values.
Workers AI and earlier Azure models retain their prior uncached behavior.

- `message.phase` transitions (`src/chat-runtime-phase.ts`): `planning`,
  `using_tool`, `generating`.
- `tool_input` progress frames (`src/chat-tool-input-progress.ts`) carrying
  only `{ toolCallId, chars }`, never the input. The widget shows a
  tenant-authored activity label (`app_tools.invocation_status`) or a generic
  one; callable names never render.

## Computer and Tool Ledger

Native Computer files and `exec` cover lightweight scratch work. For installed
software, tests, builds, or repository work the model calls `open_computer`
first; the host selects and reuses the task's Linux environment. A long command
detaches and returns an execution id; its completion arrives as its own turn,
so the model never polls. `read_execution` looks on demand,
`cancel_execution` stops, `close_computer` releases. `code_search` is the
repo-wide search tool (one ripgrep call returning bounded
`{ file, line, text }` matches).

Coding delegations use one repository workflow: `open_computer({ repository: true })`,
then native files and Git through `exec`. This presentation is selected from
the existing `requiredProofKind: "code"` / `repository_edit` capability and
grants no extra permissions.

Every Computer call is a ledger row: `tool.started` (command and bounded,
redacted arguments) and `tool.completed` (`ok`, `exitCode`, `executionId`,
bounded `resultPreview`) through `src/native-tool-ledger.ts`. Rows are keyed by
the model's tool-call id and sequenced from a wall-clock cursor
(`src/ledger-sequence.ts`), so a DO eviction mid-turn cannot reissue ids the
run already wrote.

`resultPreview` fits 1,024 characters after shared redaction. Each present
stream gets its own share, with head/tail excerpts and `omittedChars`; absent
and empty streams stay distinct. A preview cannot infer success, timeout, or
persistence — only the originating receipt can.

A terminal workstation process registers its `stdout.log`, `stderr.log`, and
`evidence.json` R2 objects as `tedi_artifacts` rows named
`workstation_process/<processId>/<file>`; `artifact_read_file` resolves them
through that index.

## MCP Turns

MCP `run_tedi_turn` and inject calls always dispatch a workflow. They
acknowledge once the queued runtime event is readable, without waiting for the
model. Task-capable clients poll MCP Tasks; nested Code Mode calls get a
pending receipt and read the reply with `messages_read`. Retry with the same
`client_request_id`. A dispatch failure keeps the run identity and never falls
back to a second inline execution. Ephemeral sessions keep their no-ledger
behavior.

Durable Code Mode lives inside `AgentTediDO`, not the stateless `apps/mcp`
gateway, because state, approval, and replay must belong to one tedi identity
([codemode.md](../mcp/codemode.md)).

For a successful read-only connected-app tool, the gateway attaches a
collection-read observation (from the tool's `config.readCollection`, else
`collection: null`) outside model-visible data. The terminal `tool.completed`
event carries it as `collectionReads`. It records which collection was read,
not which records, and does not gate reads.

## Pi Storage and Recovery

`src/pi-agent.ts` hosts native Pi SQLite storage and wake jobs through
`agents/harness/pi`. Existing child DO names remain. During persisted-state cutover, the old session
tables remain under an explicit passive importer.
Passive import uses deterministic IDs and rejects unresolved stored submissions;
imported user rows never start generation. Completed answers are selected by
native submission ownership rather than recency.

`src/pi-model.ts` reserves each actual provider dispatch through the durable
facet accounting journal. Its existing storage namespace is retained
so an upgrade cannot forget prior reservations. Missing usage remains unknown,
not zero. Usage settlement is awaited before the native completion event.

Recovery rules:

- Workflow retries are only for recoverable failures. Tool failure, exhausted
  ceilings, and an already-stopped run return typed terminal failures.
- Each recovery rechecks the persisted parent admission, its budget class, and
  the cancellation tombstone. Missing identity or unreadable state denies
  automatic continuation without discarding partial output. A run crossing UTC
  midnight opens an admission against the new day without changing identity.
- A delegated facet fails when its Attempt heartbeat is rejected **and** a
  fresh read confirms the Attempt is terminal; a stale heartbeat alone is not
  enough.
- A missing parent tool registry returns `facet_tool_unavailable`, fences the
  run, and interrupts inference rather than answering without tools.
- Every provider dispatch rechecks cancellation before inference.

facet accounting journals each provider attempt before dispatch
and persists its usage receipt before reconciling the budget; receipts are
keyed by run and attempt, so retries do not double-debit. Before a mutating
tool runs, its call id is journaled as an effect fence. Recovery requires a
terminal receipt for each open fence, either in the native checkpoint or
from the parent-owned exact dispatch journal (`src/facet-dispatch-journal.ts`).
The parent records a terminal marker only after a proxied tool returns. The
marker does not retain its output or prove that external effects succeeded;
recovery tells the model to inspect state without replaying the call. A dispatch
without a terminal marker stays fenced and ends as
`Interrupted tool effects require reconciliation before recovery`. Read-only
tools (`repo_load`, `read`, `read_execution`, `read_skill`,
`deliverable_read_artifact`) create no fence.

**Non-guarantees.** The journal is local accounting, not D1 settlement or
provider idempotency. Fences prevent automatic replay; they do not make
external effects atomic. A recovered request without a measured receipt retains its reservation; a new
provider dispatch needs fresh admission and separately recorded usage.

Test lane: `bun run --cwd apps/tedi-runtime test:workers` and
`bun run --cwd apps/tedi-runtime type-check:workers` exercise real DO resets with scripted providers.

## Protocol Surface

| Route                 | Purpose                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/acp`                | Pi chat WebSocket using the `agents/chat` frame vocabulary                                                          |
| `/mcp`                | Streamable HTTP MCP over `src/mcp-mount.ts`                                                                         |
| `/chat/capn`          | Embedded-product Cap'n Web root; in-band auth returns a capability pinned to tenant, origin, user, and conversation |
| `/__admin/agent-diag` | Service-binding diagnostics for state, queues, schedules, and artifacts                                             |
| `/__admin/schedules`  | Read-only list of the DO's Agents-SDK schedules (skill workflows schedule from D1 instead)                          |

The edge Worker (`apps/tedi`) keeps the public host, auth, and admin API
stable while routing runtime work here and OS/process work to workstations.

`@tedix/chat-transport` is the shared connection layer for Tedix OS and
embedded widgets. OS Home chat uses the OS Cap'n Web session root
(`apps/os/src/capnweb/session-root.ts`) and API `kernelRuntime` handlers. The
widget exchanges its host session for a short-lived signed token and
authenticates it inside `/chat/capn`; each capability revalidates the token per
operation. Reconnect resumes from the last fully delivered event id and never
retries turn creation. Embedded path: `/chat/capn` →
`createEmbeddedCapabilityAdapter` → `/__internal/chat/stream` →
`ConversationFacet.streamConfiguredConversationTurn`.

The same capability can list, attach, and detach named organization
capabilities and immutable artifact revision pins (single-file, same
conversation, recorded SHA-256). Each turn revalidates them and injects them as
untrusted context. They never expand tools, scopes, connections, or FGA
permissions.

**Non-guarantees.** The capability does not recover a run the runtime no
longer retains and does not make external tools idempotent. A transport
interruption resumes the same run; it never starts a replacement.

Telegram uses native Chat SDK ingress and the durable reply task in
`src/pi-parent-services.ts`. The authenticated event and immutable turn metadata
are persisted before execution. Reply intent precedes external send; its receipt
precedes task completion. An uncertain external send is fenced for reconciliation
rather than automatically resent.

## Cron

The `cron` tool (`list`/`add`/`remove`/`status`/`run`) schedules Agents-SDK
jobs. Every fire is a full agent turn, and the tool is reachable from the
tedi's own tool selection, so a bad turn or injected content could install a
schedule that runs forever. `add` is bounded mechanically in `src/cron.ts`:

| Ceiling                     | Rule                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Recurring interval floor    | `MIN_RECURRING_INTERVAL_MS` (one minute)                                                                       |
| Sub-minute cron expressions | Rejected (6-field expressions with a seconds column)                                                           |
| Jobs per tedi               | `MAX_SCHEDULED_JOBS`, counted from live schedules                                                              |
| Expiry                      | Recurring tool jobs expire (`DEFAULT_TOOL_CRON_TTL_MS`, max `MAX_TOOL_CRON_TTL_MS`); renewal is a named re-add |

`add` is idempotent by name. One-shot `kind=at` jobs are not interval-capped
and carry no expiry. Policy-pack template jobs (`source: "template"`) are
reconciled from D1 and never expire. Expired jobs cancel themselves at fire
time and emit a `cron_governance` datapoint.

- **Protected names.** `cronPolicy.protectedCronNames` on the policy pack
  lists jobs the tool may not remove or replace. It is admin config, not
  reachable from any agent tool, and the check fails closed.
- **Orphaned DOs.** Rebinding a tedi to a fresh DO does not cancel the old
  DO's alarms. On every fire, `isOrphanedIsolateDo` compares the DO name to
  the tedi's `isolate_agent_id`; a proven orphan (or a DO whose tedi row is
  gone) cancels its own schedules. Lookup errors fire normally, so the guard
  can only stop a proven orphan.
- **Reconcile.** Policy-pack `cronPolicy.cronTemplates` reconcile onto the DO
  scheduler by name (`planCronReconcile`). `tedis.triggerCronSync` forces a
  warm DO to re-reconcile. A failed policy read authorizes neither additions
  nor removals.
- **Execution stamps.** Every named fire writes a `tedi_cron_executions` row
  (`running` → `success`/`failure`) below the tool surface, so loop health
  does not depend on the model journaling it. Stamps are fail-soft.
- **Skill schedules.** Scheduled skill workflows live in D1 `skill_schedules`
  and are dispatched by `dispatchDueSkillSchedules` in `apps/api`, recorded as
  `skill_runs` ([skills.md](../cognition/skills.md)). The same cognitive loop
  may currently exist both as a conversational alarm and as a skill schedule;
  retiring one requires updating its policy and checking both surfaces.

## Inference Guardrails

Model spend is bounded below the prompt layer; instructions and tools cannot
override it.

Legacy daily budgets receive operator recovery anchors only for the historical
days and balances captured before adding the missing anchor columns. A local
SQLite migration journal snapshots both allowances atomically, then resumes
column creation and backfill independently after a storage failure. New days
retain NULL anchors and the configured ceiling; retries preserve balances and
the original recovery allowance. A column deployed by older code without this
journal is left as-is: its NULLs cannot distinguish an interrupted old backfill
from an ordinary new day. Unexpected migration errors propagate and prevent
budget initialization from succeeding.

| Guard              | Enforcement                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily tokens/turns | `dailyTokenLimit` / `dailyMessageLimit` reserved atomically in the parent DO before a provider call (`src/inference-budget-store-do.ts`)                                                                                                                            |
| Reserve lanes      | Background work stops first; governed-learning schedules may use a protected slice; operator turns may use the full ceiling (`src/inference-guardrails.ts`)                                                                                                         |
| Entitlement        | Every call uses `runtimeEntitlements.authorizeInference`; missing `TEDIX_BILLING_SETTLEMENT_MODE` fails closed                                                                                                                                                      |
| Request size       | Bodies over `TEDI_MAX_AI_REQUEST_BYTES` fail before the AI Gateway fetch                                                                                                                                                                                            |
| Context growth     | Native Pi compaction reserves 15% of the selected context window and keeps 20,000 recent tokens (`ConversationFacet.piSettings`); provider overflow classification enters native `CompactionTask` recovery (`src/conversation-facet.ts`, `src/context-overflow.ts`) |
| Provider rounds    | Opt-in step ceilings (see § Step ceilings)                                                                                                                                                                                                                          |
| Tool-result size   | MCP results re-entering context are capped; oversized values use a `__tedix_truncated` envelope                                                                                                                                                                     |
| Delegated context  | Cron fires see only Code Mode; Home-delegated children get an execution-only surface; operator chats keep the full surface                                                                                                                                          |
| Delegation grants  | With an earned-delegation envelope, each tool decision is recorded as `delegation.authority.evaluated` (shadow or enforce, per org policy; `src/delegation-authority.ts`)                                                                                           |
| Attribution        | `cf-aig-metadata` carries `tediId`, `orgId`, `slug`, and a server-derived `source`, persisted to `tedi_call_costs.source`                                                                                                                                           |

Per-tedi daily limits default to `-1` (use shared organization capacity);
zero denies that dimension. Organization admission always applies.

**Non-guarantees.** Admission uses a character-based estimate, so one request
can settle above the remaining budget; the request-size ceiling bounds the
overrun. A reserve is admission capacity, not prepaid capacity. Observer and
compaction calls are size-guarded and org-admitted but not added to the
per-tedi daily ledger.

When a scheduled fire is refused for budget or billing reasons it is a
terminal governance result, not a retryable fault. The DO persists a
suppression marker (`cronBudgetSuppression`, `src/do.ts`) and skips later fires
until the next UTC day or until capacity frees; `cron({ action: "run" })`
returns `dispatched`, `suppressed`, or `skipped` with the reason. For skill
schedules, `dispatchDueSkillSchedules` probes `/__admin/budget-status`, skips
and advances an exhausted schedule, and records it
(`recordSkillScheduleSuppressed`) as `budget_blocked`.

## Chat Model Selection

The default compatible model is `cloudflare/auto`; fixed refs are governed
exceptions. Selection resolves server-side (`getModelPolicy`,
`apps/api/src/rpc/routers/tedis/config.ts`):

1. Per-tedi override `tedis.runtime_overrides.agents.defaults.model.primary`,
   normalized and validated by `apps/api/src/lib/tedi-model-overrides.ts`;
   unknown refs fall through.
2. `runtime_profiles.config.modelPolicy.chatModelRef`.
3. `cloudflare/auto` as the generative default.

Selection is per surface (`src/model-policy.ts`): chat and cron resolve their
configured refs; observer resolves its observer policy. Parent runtime, operator
and voice reasoning, conversation/synthesis facets, unpinned judge, reflection
and MCP elicitation use that configured selection. Explicit fixed-model or
residency constraints reject incompatible Auto routing. Provider failures do
not switch providers; deterministic tool authority remains separate.

The DO caches resolved policy until refresh or eviction. Home/kernel uses
`KERNEL_MODEL_REF`, defaulting to `cloudflare/auto`, including route planning,
judgment and evaluation. Explicit operator pins remain supported. Specialized
STT/TTS/Jev contracts keep their native paths. There is no per-user model
preference.

`modelCatalog.list` (`packages/api-contract/src/contracts/model-catalog.ts`,
MCP `list_models`) answers "which models may this caller use, and why". It is
a projection over the same helpers the enforcing paths use and returns the
filter chain per model (provider wiring, provider health, entitlement, org
tier, tedi tier, runtime compatibility, caller permissions). Inputs with no
backing store report honestly: the org tier ceiling without a policy row is
`not_configured`, and provider health without a durable observation is
`unknown`, never `allow`.

## When to Attach a Workstation

Do not promote a tedi just because a task needs more tools; prefer native
tools, skills, workflows, and MCP apps. Attach a workstation only for a
concrete OS/process need — long-lived shell/filesystem, browser/CDP that
outlives a request, native dependencies, long-running processes, ports, or dev
servers — and release it when done. Identity, session, and harness stay in the
Agent runtime. For collaboration, prefer one workstation with several tedi
seats over several leases.

## Verification Lanes

Never collapse runtime health into one "running" claim. D1 shows the control
plane is configured; public status shows the runtime responds; diagnostics show
the process is healthy; MCP tools show the tedi can act; Tedix OS chat shows an
operator can drive it; session readback shows the result persisted.

## Certification

The Agent runtime is the only certified runtime. A second runtime starts by
filling a manifest and backing its gates with proof, not as a spike.

- **Manifest.** `packages/api-contract/src/schemas/body-certification.ts`
  defines `BodyCertificationManifest` (session, capabilities, events,
  telemetry, lifecycle, isolation, approvals, cost envelope, and proof refs).
  `AGENT_FACET_MANIFEST` is `certified`. `assertCertifiable` rejects
  `certified` unless `smoke`, `mcp_validation`, `eval_run`, and `trace_bundle`
  proof refs match the manifest.
- **Gates.** Session through `TediSessionHarness`; runtime-neutral events with
  stable ids; tenant identity, scopes, secret boundary, trace safety; explicit
  capabilities; usage/cost/failure/approval/artifact telemetry;
  stop/replay/diagnose/repair; losing runtime-local state without losing
  cognitive state.
- **Result envelope.** Every episode emits a runtime-neutral
  `BodyExecutionResult` (`packages/api-contract/src/utils/body-execution-result.ts`),
  stored at `TraceBundle.metadata.bodyExecutionResult`; kernel episodes write
  the same envelope with `bodyKind: "kernel"`.

A manifest is not proof of what is deployed; read live results before claiming
production certification. Operators inspect them through the tedi MCP tools
`harness_versions`, `harness_trace_bundle`, `harness_eval_runs`,
`harness_compare`, and `harness_promote`.

## Related

- [cognition/runtime.md](../cognition/runtime.md), [cognition/harness.md](../cognition/harness.md)
- [cognition/kernel-execution-model.md](../cognition/kernel-execution-model.md)
- [mcp/codemode.md](../mcp/codemode.md)

### Request size and compaction

The shared transport serializes the complete request without a local 90 KB
refusal or a byte-derived compaction ceiling. Compaction uses the configured
context window and documented model input budgets. The separate deployment
request-admission policy remains in effect. Provider context and request errors
propagate without removing task, authorization, history, or tool definitions.

### Retained session byte preservation

The passive cutover operator also supports `inspect_session_preservation`,
`capture_session_preservation` and `audit_session_preservation`. These verbs
require an original positive nonactive generation and the existing canonical
root or registered-path custody fence. A purpose-bound encrypted plan binds
exact source bytes and prior archive state; it grants no execution authority.

The distinct `session-state-archive-v1` selects `session_entries` and the seven
retained SDK Session tables, including inactive branches, message chunks and
attachment bytes. It streams large TEXT/BLOB cells into bounded archive parts
and preserves INTEGER values as exact decimal text. Unsupported locators,
schema allocations or provider query failures refuse before capture; a failed
capture transaction rolls back. Existing historical and native archive formats,
selectors and seals remain unchanged. A prior native archive whose original
generation or registered path differs from the current qualified custody is
unsupported and causes refusal; its bytes remain untouched.

This selected archive does not import context, clear accounting, authorize
funding, activate a replacement or permit source deletion. SDK jobs, schedules,
workflows, optional FTS and older assistant tables, workstation state, remote
artifacts and R2 objects remain outside its coverage. Missing selected tables
are observed absence, never proof of complete customer history. Actual writer
exclusion and operational capture require separate authorization.

### Archived session semantic qualification

`inspect_session_rehydration` authenticates one original Session8 archive under
its existing nonactive custody and then validates recognized parent-local and
SDK Session semantics. It reads no canonical D1 transcript and performs no
SDK startup, storage write, model call, context import or selection. Its strict
response reports `archived_selected_session8`,
`canonicalLedgerCorrespondence: not_queried`, `adoptionReady: false` and
`executionEligible: false`.

The version 2 semantic reader bounds archived source and retained payload to
8 MiB each, selected SQL rows to 20,000, charged semantic work to 200,000 units,
and scanner byte passes to 64 MiB, under the original 30-second local deadline.
The exact authenticated framing count remains an integrity check; cell and
payload frames do not count as SQL rows. The strict budget witness separates
unclipped selected-row totals, consumed rows, work, bytes and first exhaustion.
A source within one limit can exhaust another; 20,000 rows do not promise a
supported projection. Complete archive authentication remains mandatory before
budget observations; over-budget results report `budget_unavailable` with zero
semantic counts, preserving all archive bytes. Attachment cells are streamed
and hashed without constructing hydrated binary/base64 output.
Unknown schema, malformed graphs, unresolved tools or inconsistent chunks and
attachment references cannot yield a supported projection. Supported local
semantics establish neither current-source continuity nor complete canonical
customer history. Missing archives and selected tables remain observed absence.

Deploy the strict API before its matching runtime; the interval refuses the
new verb on the old runtime. Restoration, full custody-graph qualification,
writer exclusion, canonical ledger correspondence and current financial
permission remain separately authorized work. The existing Home/kernel and
embedded native Pi chat backends retain their current ownership.

### Selected SDK work state preservation

The separate `sdk-work-state-archive-v1` observer and writer preserve the fixed
43 SDK SQL selectors and every supported native KV entry under original positive,
nonactive Raw custody. The commands are `inspect_sdk_preservation`,
`capture_sdk_preservation`, and `audit_sdk_preservation`. Planning is read-only;
capture requires its original encrypted plan and archive UUID. Every awaited
boundary rechecks source, prior archives and custody. Inspect and capture also
enforce the original plan deadline. Long-term audit authenticates the stored
proof without expiring it, renewing its deadline or authorizing execution.
Transaction-internal capture refusals roll back archive writes. After commit, a
publication refusal does not prove that the archive is absent. Request-local
synchronous guards recheck the complete selected source and archive state after
result awaits, including rejected results, and before local response publication.
An absent-archive audit still validates the full supported source and prior archives.
A later retry requires a read-only destination audit; an error alone is no proof of nonpersistence.

SQL cells stream in bounded frames, including large TEXT/BLOB cells and exact
INTEGER text. KV entries use the existing typed private codec; an unsupported
value, schema or locator refuses the whole capture. Selected FTS virtual tables
or their shadow tables also refuse the whole capture. No partial archive or
truncated success is returned. Historical, native and Session8 archive formats
and their authenticated readers retain their original bytes and selectors.

Alarm state is omitted from the source, proof and archive. Responses always say
`alarmCovered: false` and `alarmConsistency: "UNKNOWN"`; they make no atomic
alarm, whole-object, full-graph, remote workflow, financial clearance, restoration
or activation claim. Public metadata contains safe counts and an opaque archive
UUID. Source bytes, SQL schema text, KV keys, credentials and raw source digests
remain private. The 1 MB encoded KV-record bound is a refusal rule, not a proof
that provider deserialization allocates at most that amount.
