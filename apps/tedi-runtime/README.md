# @tedix/tedi-runtime

The Agent runtime — the default tedi body. Every tedi is served here.

## Overview

`tedix-tedi-runtime` is a Cloudflare Worker that hosts `AgentTediDO`, a
Cloudflare Agent Durable Object (DO) with native Pi cognition holding a tedi's canonical cognitive
loop: chat turns, MCP tool serving, email, scheduling, voice, and durable
workflows. `apps/tedi` (the public edge/control Worker) resolves a tedi from
D1 and forwards its traffic here via the `TEDI_RUNTIME_SERVICE` binding; this
Worker can also resolve `{slug}.tedi.{tedix.dev|tedi.club|tedix.tech}`
hostnames directly (`resolveSlugFromHost` in `src/slug-routing.ts`) and independently
authenticates every request at its own edge before it reaches the DO. The public
[worker model](../../docs/public/workers-and-governance.md) describes the
identity/runtime separation; `apps/tedi/README.md` describes this repository's
edge/runtime/workstation split.

### Entry points (`src/index.ts`)

- `email()` — Cloudflare Email Routing inbound handler. `email-ingress.ts`
  archives MIME in `TEDI_STORAGE`, persists the mailbox through `API_SERVICE`,
  then dispatches eligible primary addresses to `AgentTediDO`.
- `/health`, `/` — static liveness.
- `/mcp` — MCP tool serving. Auth: Tedi V2 JWT, Descope user JWT, or
  `sk_` API key (`X-API-Key`), enforced by `createMcpAuthMiddleware`
  (`@tedix/mcp-shared/auth`) plus an org-match guard against the tedi's
  Descope tenant.
- `/acp` — WebSocket upgrade for the Agent Control Protocol session, same
  auth surface as `/mcp` but validated at the upgrade.
- `/voice/call`, `/voice/input`, `/voice/provider-health` — live browser
  voice (Deepgram STT/TTS via Workers AI), gated by the `AI` binding; upgrades to the sibling `VoiceCallDO` /
  `VoiceInputDO` Durable Objects, which hold no canonical state and consult
  the tedi's `AgentTediDO` loop over RPC for turn logic.
- `/hooks/chat-stream`, `/hooks/inject`, `/hooks/cancel-turn`,
  `/hooks/mesh-inject` — service-
  binding-only endpoints for native SSE chat streaming,
  operator/system message injection, workflow cancellation, cross-tedi mesh
  sends.
  The skill-runtime benchmark adapter calls `/hooks/chat-stream`; route
  availability alone does not establish a consumer for every hook.
- `/chat/capn` — embedded conversation capability. Its adapter consumes the
  private native stream and sends browser callbacks. Tedix OS Home chat uses
  the API kernel through the OS Cap'n Web session root.
- `/webhooks/telegram` — public Chat SDK Telegram webhook; authenticity is
  checked inside the DO (`TELEGRAM_WEBHOOK_SECRET`), not at the Worker edge.
- `/__admin/*` — maintainer workflow control surface, gated inside the DO by
  a shared-secret header.
- `/.well-known/oauth-protected-resource` — RFC 9728 discovery, served at the
  Worker edge so it works without a tedi-specific auth gate.

### Durable Objects and Workflows

- `AgentTediDO` (binding `TEDI_AGENT`) — the canonical tedi loop: `do.ts`
  orchestrates chat turns, MCP mounting, brain/rationale/artifact bridges,
  skill guidance, repo commit/load, adaptive learning, and more (see the
  many single-purpose modules under `src/`, e.g. `chat-turn-workflow.ts`,
  `ledger-mirror.ts`, `repo-commit-drain.ts`, `voice-recap.ts`).
- `ConversationFacet`, `JudgeSessionFacet`, and `SynthesisSessionFacet` —
  colocated native Pi sub-agent facets resolved through `ctx.exports`.
  `ConversationFacet` owns ordinary tool-capable conversations,
  `JudgeSessionFacet` is structurally blind/tool-free for verification, and
  `SynthesisSessionFacet` is a fresh tool-free facet per `workflow:synth:*`
  run. The synthesis path retains persona, chat-model policy, admission, usage,
  and ledger settlement while skipping general tool construction, MCP
  instructions, prior history, cognitive addenda, and memory effects.
- `VoiceCallDO` / `VoiceInputDO` — live voice call and dictation-only
  sessions, keyed `${slug}:${conversationKey}` / `${slug}:input`.
- `ChatTurnWorkflow` (binding `CHAT_TURN_WORKFLOW`) — Cloudflare Workflow that
  runs a chat turn durably (`step.do` checkpoints), so a turn survives DO
  eviction or a mid-turn redeploy instead of being lost with an in-memory
  DO alarm.

### Bindings

- D1 `DB` — tedi/organization rows, ledger, skill/rationale tables.
- R2 `TEDI_STORAGE` and `ARTIFACTS` — tedi file storage and the Artifacts
  repo (SOUL/IDENTITY/USER docs, generated files).
- `worker_loaders.LOADER` — Dynamic Worker Loader for durable Code Mode and
  Cloudflare Computer's `WorkerShellBackend`. Computer mints a fresh just-bash
  isolate that reaches the authoritative workspace through a scoped
  `WorkspaceServiceProxy` capability.
- `ai` (`AI`, remote) — Workers AI, used for voice STT/TTS and explicitly selected
  Workers AI models.
- `browser` (`BROWSER`, remote) — Browser Rendering, for the `browser.*` MCP
  tool namespace.
- `send_email` (`EMAIL`) — outbound email via Cloudflare Email Routing.
- Service bindings to `apps/api`, `apps/mcp`, and others as needed by
  individual routes.
- Required secrets: `SECRETS_MASTER_KEY`, `DESCOPE_PROJECT_ID`,
  `DESCOPE_BASE_URL`, `AZURE_OPENAI_RESOURCE`,
  `EMAIL_SECRET`, `CF_WORKERS_AI_TOKEN`, `CF_AI_GATEWAY_TOKEN`.

Deployed with `workers_dev: false` and `logpush: true`; Workers Trace Events
ship to R2 as operational records. See
[workers and governance](../../docs/public/workers-and-governance.md).

### Computer workspace and execution

`AgentTediDO.workspaceVfs` reaches a Cloudflare Computer `Workspace` in the
separate `TediComputerWorkspaceDO` through its scoped RPC capability. It registers the `isolate` Worker backend (an internal label for the Agent
runtime's Computer backend, not a second runtime) and
serves Computer's native `read`, `ls`, `find`, `grep`, `write`, `edit`,
`delete`, and `exec` tools on
every tool-capable turn. Pi receives only the exact parent-proxied tool
descriptors; judge and synthesis facets expose no tools.

Text reads are line-numbered and bounded to 1,000 lines / 64 KiB per call;
pagination preserves the continuation point, and supported images or PDFs can
flow through Computer's model-output adapter. The Worker backend receives only a loopback Workspace stub for the current
`TEDI_AGENT` Durable Object. It has no public network and no Durable Object
namespace. Native processes, installs, builds, tests, and dev servers still
route through a governed workstation lease.

## Running it

```sh
bun run test:run           # runs every src/*.test.ts standalone (not `bun test`)
bun run type-check
```

This repository does not yet include the isolated bindings and secret
bootstrap required to run or deploy this Worker. The `dev` and deploy scripts
are maintainer-only until the public installation path described in the
[self-hosted boundary](../../docs/public/self-hosted-boundary.md) is complete.

## Facet metrics (Analytics Engine)

Facet turn observability writes to the `RUNTIME_ANALYTICS` binding
(the Analytics Engine dataset declared in the installation manifest), because the co-located
`[conversation-facet]`/`[judge-facet]`/`[dangling-turn]` console lines are
request-context logs that Workers Logs samples away under load. Builders and slot orders live in
`@tedix/api-contract/schemas/mcp-analytics` (`FACET_TURN_ANALYTICS_*`,
`DANGLING_TURN_ANALYTICS_*`).

- `facet_turn` (blob1): blob2=surface (`mcp|sse|email|judge`), blob3=tediId,
  blob4=outcome (`complete|error`), blob5=errorClass, blob6=facetName hash;
  double1=turnMs (facet-reported), double2=totalMs (parent wall time incl.
  spawn/RPC and the full tool/model turn), double3=firstFacetTurn (1 on the
  conversation's first facet turn — spawn/hydration cost),
  double4=turnCount. Latency p50/p95 per surface describes completed calls; a
  long complete row is not orphan evidence:

  ```sql
  SELECT blob2 AS surface,
         quantileWeighted(0.5)(double2, _sample_interval) AS p50_total_ms,
         quantileWeighted(0.95)(double2, _sample_interval) AS p95_total_ms,
         sum(_sample_interval) AS turns
  FROM example_runtime_analytics
  WHERE blob1 = 'facet_turn' AND blob4 = 'complete'
    AND timestamp > now() - INTERVAL '1' DAY
  GROUP BY surface
  ```

  Error rate: same query with `blob4 = 'error'`, grouped by `blob5`.

- `dangling_turn` (blob1): blob2=surface, blob3=tediId, blob4=sessionKey
  hash; double1=ageMs. This means the recent-window transcript cache had an old
  trailing user row when a later turn arrived. It is a diagnostic correlation,
  not proof that the canonical D1 ledger lacks a run terminal; group by both
  tediId and session hash and correlate with `flywheel.get_orphan_run_health`:

  ```sql
  SELECT blob3 AS tedi_id,
         blob4 AS session_hash,
         sum(_sample_interval) AS weighted_sightings,
         max(double1) AS max_age_ms
  FROM example_runtime_analytics
  WHERE blob1 = 'dangling_turn'
    AND timestamp > now() - INTERVAL '7' DAY
  GROUP BY tedi_id, session_hash
  ```
