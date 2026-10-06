# @tedix/skill-runtime

Executes tenant-authored skills, automations, and flows in per-run, sandboxed Worker
isolates with durable execution semantics.

## Overview

`tedix-skill-runtime` is the execution engine behind Tedix skills. A skill run
compiles/loads tenant workflow
source, dispatches it as a Cloudflare Workflow instance, and runs the
workflow body inside a run-and-execution-epoch-scoped isolate via
[Dynamic Workers/Workflows](https://blog.cloudflare.com/dynamic-workers/)
(`env.LOADER` + `@cloudflare/dynamic-workflows`), giving `step.do` /
`step.sleep` / `step.sleepUntil` / `step.waitForEvent` durability without
trusting tenant code with platform credentials.

Cloudflare Workflows remains the execution engine: it owns durable step
identity, retries, timeouts, waits, rollback, and instance lifecycle.
`@cloudflare/dynamic-workflows` carries the non-secret routing envelope to the
loaded Worker; it does not add a second scheduler. Tedix owns admission,
identity/capability policy, pinned source, submission accounting, and the
agent-readable evidence projection around those primitives.

The host Worker and loaded tenant isolates target compatibility date
`2026-06-11`, matching the Cloudflare Agents workflow examples. Every epoch
manifest records that date together with the deployed Worker and dispatch-shim
versions so behavior changes remain attributable.

Internal-only Hono API (`src/index.ts`), authenticated via service binding or
`PLATFORM_SERVICE_TOKEN` (see `src/auth.ts`):

- `POST /run` — creates a `skill_runs` D1 row (run-pinned: `workflowSource`,
  `skillDoc`, `capabilityManifest`, and `skillRevision` are snapshotted at
  dispatch time, never re-read from live `skill_entries`) with an explicit
  `WORKFLOW_ADMISSION_PENDING` marker. It then admits and starts the matching
  durable runtime-submission attempt before dispatching a `SkillWorkflow`
  instance via `wrapWorkflowBinding()`. The row becomes `queued` only after
  engine creation is accepted. An optional UUID
  `runId` makes admission idempotent: an exact pinned-snapshot replay returns
  `deduplicated: true`; a collision with different identity/source fails with
  `409 run_id_conflict`. When neither `runId` nor `idempotencyKey` is supplied,
  a 60-second D1 admission fence over the full pinned run snapshot and params
  converges burst retries onto one canonical run. The fence expires so a later
  intentional invocation with identical inputs still creates a new run.
  Deterministic IDs are scoped to the persisted runtime environment; production
  preserves its existing ID format. Historical environment values remain part
  of stored run identity. Every run/control
  route checks the stored environment before touching the environment-specific
  Workflow binding. New admissions pass through `RUN_RATE_LIMITER`.
- `POST /status` — reconciles a run against the live Workflow engine state
  (`queued`/`running`/`paused`/`completed`/`failed`/`canceled`) and returns
  the raw engine snapshot alongside the mapped status. Raw `waiting`
  (sleep/retry/event hibernation) maps to public `running`; only
  `waitingForPause`/`paused` maps to public `paused`. If engine acceptance won
  but admission-marker clearing was lost, status compare-and-set (CAS) stages that exact marker
  to a non-terminal state before submission settlement and terminal projection.
- `POST /pause` / `POST /resume` — use the native Workflow instance controls,
  confirm the resulting engine state, and only then update D1. The API sends
  the run's `expectedExecutionEpoch`; a stale control cannot mutate a newer
  restarted execution. Pause/resume/cancel/restart/approval/event controls
  conflict while initial admission is ambiguous; all controls except restart
  also conflict while a native restart intent is still being reconciled.
- `POST /restart` — requires a caller-stable `restartId` (1–128 characters), reserves a new
  `execution_epoch` plus restart intent, and invokes native restart exactly once
  for a completed or errored instance, from the beginning or
  `{ name, count?, type? }`. A resolved call records an accepted receipt and
  returns provisional `queued`; reconciliation keeps the restart fence until
  an accepted restart exposes any non-terminal/terminated engine state or
  exact-epoch terminal evidence matches the engine fingerprint. A prior engine
  snapshot can only be completed/errored because those are the only restartable
  states, so queued/running/paused/terminated is authoritative even when the
  start record is missing; a stale pre-restart terminal snapshot cannot settle
  the new execution. Retries with the
  same ID repair D1/ledger state without restarting again. The run row pins the
  winning `restartId`; if the Worker dies after engine acceptance, new-epoch
  start evidence promotes that exact pending/unknown receipt to accepted.
  Pending/unknown receipts without start evidence fail closed for inspection.
  After verifying the reserved epoch never started and the engine remains on
  its prior terminal execution, an operator can replay the exact `restartId`
  and `from` with `{ abortUnknown: true, reason }`. The receipt CAS first blocks
  a late epoch start; Tedix then materializes the exact reserved submission
  attempt, settles it `canceled`, atomically projects the run as `canceled`,
  clears stale result/error/cost state and the restart intent, and returns
  `restartAborted: true`. It never calls the engine. An exact retry deduplicates
  across every recovery boundary; changing `restartId`, `from`, or `reason`
  conflicts. Because the ambiguous invocation may still arrive later, the
  operator-abort receipt permanently retires that Cloudflare Workflow instance:
  any later native restart conflicts before reservation, and the caller must
  start a new run with a new `runId`/idempotency key. Both the restart-receipt
  claim and every epoch-start insert atomically refuse a committed operator
  abort, so SQLite serialization permits only one side of the start/abort race
  to win.
- `POST /cancel` — terminates the Workflow instance, optionally with
  `{ rollback: true }`, and confirms `terminated` before marking the run
  canceled. Terminal projection first settles the matching epoch's durable
  runtime submission.
- `POST /event` — delivers a typed event to `step.waitForEvent`. It is not
  idempotent; callers must inspect instead of blindly retrying after an
  ambiguous transport failure.
- `POST /approve` / `POST /reject` — send Cloudflare Agents' canonical
  `approval` event with `{ approved, reason?, metadata? }`. A non-empty
  `approvalId` is required and nested under `metadata`; a durable
  `epochs/{executionEpoch}/controls/approvals/{encodedApprovalId}.json` receipt deduplicates a delivered
  retry and rejects conflicting or ambiguous decisions.
- `POST /benchmark/drive-turn` — drives one conversational turn against an
  Agent-runtime tedi directly through `TEDI_RUNTIME_SERVICE` (the same
  `/hooks/chat-stream` SSE path the Tedix OS uses), bypassing the Code Mode
  executor's 30s budget. Foundation for a tau2-bench-style retail benchmark
  workflow.
- `scheduled()` cron (production, `*/5 * * * *`) runs `reconcileSkillRuns()`
  to sweep stale run rows against the Workflow engine.

### Tenant capability bridges

Tenant workflow code never receives platform credentials directly. Three
`WorkerEntrypoint` bridges are exported from `src/index.ts` (required so
Cloudflare can register them on `ctx.exports` for the loaded isolate to call
over loopback RPC) and are re-exported for class-name resolution:

- `McpBridge` (`mcp-bridge.ts`) — the tenant isolate's `env.MCP.<ns>.<method>`
  proxy. Validates every call against the skill's `capabilityManifest` and
  forwards allowed calls to `apps/mcp` via service binding, scoped to the
  tedi's identity. Native step context is propagated through
  `AsyncLocalStorage`; the bridge derives an epoch-scoped, retry-stable
  idempotency key and a per-attempt call ID, forwarding them as trusted headers
  and MCP `_meta`. A native retry keeps the key; a restart epoch gets a new key.
  Returned calls share the active-operation set with fetch, so an omitted
  `await` cannot let capability work outlive the native callback. An
  unobserved rejected operation fails the step; an explicitly awaited or
  handled rejection retains normal Promise semantics.
- `OutboundProxy` (`outbound-proxy.ts`) — the `globalOutbound` for skills that
  declare `capabilities.network: true`. A platform prelude first replaces and
  locks tenant `globalThis.fetch`, allowing it only while the shared native
  step/rollback context is active; this catches direct, aliased, computed, and
  floated calls. Requests are canonicalized before dispatch; WebSocket Upgrade
  intent and socket-bearing responses fail closed. Direct `WebSocket`,
  `EventSource`, and `navigator.sendBeacon` egress is disabled because its
  lifetime cannot be bounded by a durable step. OutboundProxy then injects platform-managed API keys for
  allow-listed provider hosts before forwarding; any other host passes through
  unmodified.
- `loadSkillRuntime()` re-parses the compiled tenant module with
  `es-module-lexer` immediately before Loader evaluation. Only a static
  `cloudflare:workflows` import is accepted; relative/platform imports,
  re-exports, dynamic import, and `import.meta` fail closed. This execution-time
  check protects legacy/directly persisted snapshots from importing the shared
  step context. Loaded Workers additionally set
  `disallow_eval_during_startup` and `disallow_importable_env`, closing eval- or
  string-hidden access to `cloudflare:workers` environment bindings.
- The platform gate module evaluates before the tenant module, captures the
  authority-sensitive Promise/Proxy/Map/Set/Reflect/function/date/crypto
  primitives used by the dispatch shim, and locks `globalThis.caches` to a
  throwing proxy. Own and inherited fetch authority is replaced before tenant
  evaluation; HTTP response bodies are materialized inside the tracked native
  step to a bounded 8 MiB buffer, while socket upgrades, WebSocket/
  WebSocketPair, EventSource, and beacon escape paths fail closed. Tenant code
  therefore cannot gain non-durable ambient cache/network state or monkeypatch
  the primitives that enforce fetch/MCP boundaries. The non-secret run context
  is structured-cloned and recursively frozen before it reaches tenant code;
  bridge routing continues to use the trusted frozen snapshot rather than a
  tenant-replaceable `env` property.
- `ArtifactBridge` (`artifacts.ts`) — lets `step.*` wrappers persist run
  artifacts (`recordRunArtifact`) without giving tenant code D1/R2 access
  directly; payloads ≤16 KiB inline in `skill_run_artifacts`, larger payloads
  spill to the `SKILL_ARTIFACTS` R2 bucket.
- `RationaleBridge` (`rationale.ts`) — records rationale/decision trail
  entries for a run. Its semantic idempotency key covers run, execution epoch,
  gate, step identity, and failure attempt, so Workflow replay after
  hibernation returns the original Work management record instead of opening a
  duplicate pause/resume decision.

`DynamicWorkflowBinding` is also re-exported (required by
`wrapWorkflowBinding` so Cloudflare auto-registers the binding on the
Worker's exports).

## Bindings

- D1 `DB` (the tenant database) — `skill_runs`, `skill_run_artifacts`.
- R2 `SKILL_ARTIFACTS` — spilled artifact payloads.
- `worker_loaders.LOADER` — Dynamic Worker Loader used to run tenant skill
  code with a run/epoch/config-scoped cache identity. Isolates are disposable;
  correctness does not rely on warm-instance continuity. WorkerCode and
  `getEntrypoint()` both enforce `cpuMs: 60_000` and `subRequests: 1_000`;
  these Loader limits are pinned in runtime provenance and do not replace each
  `step.do` call's explicit retry/timeout policy.
- `workflows.WORKFLOWS` (`class_name: SkillWorkflow`) — Dynamic Workflows
  binding; the factory reads dispatcher metadata (skillId/tediId/orgId/runId)
  stashed via `wrapWorkflowBinding()`, then reads the strict pinned source,
  capability manifest, and current execution epoch before loading the tenant
  Worker. Re-parsing pinned SKILL.md is diagnostic only and cannot broaden the
  admitted capability snapshot.
- Service bindings `API_SERVICE`, `MCP_SERVICE`, `TEDI_RUNTIME_SERVICE`.
- `ratelimits.RUN_RATE_LIMITER` — 60 runs/60s.
- `version_metadata.WORKER_VERSION` — immutable deployed runtime provenance
  written to `manifest.json` with pinned workflow/SKILL.md SHA-256 hashes.
- Secret `PLATFORM_SERVICE_TOKEN` (required).
- Production has a cron trigger (`*/5 * * * *`) for the environment-scoped,
  least-recently-reconciled run sweep.

Production is the only deployment target, at `skill-runtime.tedix.dev`.

## Run artifacts

The dispatch shim keeps the compatibility outputs used by existing clients:

- `outputs/<encodedStepName>.json` — latest successful output across epochs;
  redacted when the native step config has `sensitive: "output"`.
- `outputs/<encodedStepName>.error.json` — latest terminal error across epochs
  after configured retries are exhausted (never written for a transient
  attempt alone).

Cloudflare's generated types and public contract include
`StepConfig.sensitive: "output"`, and the Tedix shim supports the corresponding
redaction marker. However, live local validation with Wrangler 4.110 rejected
that config before the callback ran. Treat this as a local-dev compatibility
gap requiring production proof; never place secrets in step outputs or depend
on this flag as the only secrecy boundary.

It also writes a normalized, collision-free execution ledger:

- `epochs/<epoch>/steps/<encodedName>/<count>/attempts/<attempt>.json` — real native
  `WorkflowStepContext` coordinates, config, status, timing, retryability, and
  a reference to the compatibility output (not a duplicate full output).
- `epochs/<epoch>/steps/<encodedName>/<count>/attempts/<attempt>/calls/<phase>/<ordinal>.json`
  — lightweight MCP call status and IDs. Idempotency is explicitly recorded as
  requested with provider confirmation `unknown`; this does not claim
  exactly-once delivery. A step configured with `sensitive: "output"` redacts
  the receipt request, response, and error as well as its step output.
- `epochs/<epoch>/steps/<encodedName>/<count>/sleep.json`, `sleepUntil.json`,
  or `waitForEvent.json` — durable state for non-`do` primitives.
- `epochs/<epoch>/manifest.json` — latest-observed runtime/config summary for
  the epoch. `epochs/<epoch>/manifests/<loaderConfigHash>.json` preserves each
  exact Loader configuration identity. The hash is also part of the Loader id,
  satisfying Cloudflare's same-id/same-config invariant across deploy or
  namespace-routing drift.
- `epochs/<epoch>/started.json`, `completed.json`, or `failed.json` — execution
  fence records emitted at the static dispatcher boundary. They let
  reconciliation distinguish a new epoch from Cloudflare's briefly stale prior
  terminal snapshot. Terminal records carry a content fingerprint that must
  match the engine output/error before release; they are lifecycle proof, not
  substitutes for step evidence.
- `manifest.json`, `timeline.json`, and `outputs/...` — latest-execution
  compatibility views. Use the epoch ledger as the canonical restart-safe
  history.
- `epochs/<epoch>/controls/approvals/<encodedApprovalId>.json` — approval/rejection reservation
  and delivery receipt.
- `controls/restarts/<encodedRestartId>.json` — restart command reservation and
  accepted/unknown/rejected receipt, including the reserved execution epoch.

Step and control identifiers use a dot-safe, bounded URI component. Unsupported
encoded names fail before the native step or control side effect, so a tool
call can never execute without a valid durable receipt path. Terminal attempt,
tool-call, rollback, and timeline writes are awaited before the tenant runner
returns; the cost projection therefore cannot race an in-flight terminal receipt.

Successful control responses use
`{ ok, runId, workflowInstanceId, action, status, engineStatus, deduplicated,
executionEpoch?, operationAttempts?, statusChecks? }`. Restart additionally
returns `restartId` plus `from`, and cancel returns `rollback`. A restart
intentionally reserves its epoch/intent before calling the engine exactly once
and writes a provisional state after acceptance. Only completed/errored engine
instances are restartable, and the intent remains fenced until the new epoch is
observed; the accepted restart opens the next epoch's runtime-submission
attempt and clears the prior terminal cost rollup. Same-ID retries repair
partial failures. Other control failures do not claim
success and return a typed `workflow_<action>_failed` error.
Runtime 4xx failures (including restart/approval receipt conflicts) retain
their HTTP class and structured runtime code when `apps/api` projects them,
rather than being flattened into a generic upstream 5xx.

## Agent-facing projection

`apps/api` and the curated tedi MCP namespace expose bounded status,
inspection, step, tool-call, revision, reliability, and raw-artifact views over
this ledger. The MCP tools publish contract-derived `outputSchema`; the
namespace injects/reasserts its own tedi identity rather than trusting a caller
`tediId`. If aggregate D1 hydration cannot resolve that tedi ID, managed RPC
tools that require identity injection are omitted from the advertised catalog;
direct tedi-host calls and explicitly organization-scoped RPC tools remain.
Step/call listings use bounded, SQL path-filtered pages before exact parsed
record filtering and expose `limit`, `offset`, `truncated`, and `nextOffset`;
raw artifact inventory exposes the same pagination shape. Structured step records suppress matching
legacy `timeline.json` shadows. Reliability therefore counts each durable retry
attempt independently across runs and restart epochs, without double-counting
the compatibility timeline. Terminal status/inspection reads compute a
best-effort `costSummary` from the complete bounded evidence set; a truncated
scan stays `null` instead of persisting a partial rollup. Restart clears the
summary so the new epoch is recomputed after its next terminal observation.
Revision comparison reports source/SKILL.md changes
and runtime provenance changes (`workerVersion`, compatibility date,
dispatch-shim version, Loader config hash, tenant CPU/subrequest limits, and
`@cloudflare/dynamic-workflows` version).

Each execution epoch seals `epochs/{epoch}/runtime-pin.json` before tenant code
runs. `loaderConfigHash` selects an exact immutable Loader config, while
`executionCompatibilityHash` covers the tenant-visible source, manifest,
routing, runtime modules, flags, limits, and bridge-semantics version. A normal
deploy or credential rotation can therefore select a fresh Loader and record
`epochs/{epoch}/runtime-compatible/{loaderConfigHash}.json` without killing the
run. A changed execution surface records
`epochs/{epoch}/runtime-drift/{loaderConfigHash}.json` and fails closed with
`WORKFLOW_RUNTIME_DRIFT_BLOCKED`; use a deliberate native restart to open a new
epoch. Pins created before the compatibility hash existed remain fail-closed
across their first Loader change.

There is no native `continueAsNew()` method on the Workflow binding used by the
runtime. A workload approaching its step budget should complete with a compact
checkpoint and let its parent tedi/operator create a successor run with a new
id. Restart is replay/recovery of the same instance, not a substitute for a
successor.

## Running it

```sh
bun run test:run          # bridge + workflow runtime invariant tests
bun run type-check
```

This repository does not yet include the isolated bindings and secret
bootstrap required to run or deploy this Worker. Those scripts remain
maintainer-only; see the
[self-hosted boundary](../../docs/public/self-hosted-boundary.md).
