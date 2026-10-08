---
summary: "Tedix multi-tenant MCP runtime: one shared Worker, D1-configured apps and tools, app tiers, protocol eras, aggregate resolution, and the tedi MCP server"
read_when:
  - Changing apps/mcp runtime behavior or per-app routing
  - Updating D1-backed MCP tool loading, app tiers, or aggregate resolution
  - Checking tedi MCP server scopes or upstream protocol handling
title: "MCP runtime"
---

# MCP Runtime

`apps/mcp` is one stateless, multi-tenant MCP edge. Every app (platform base
apps, tenant proxies, customer apps, aggregators) is a set of D1 rows served by
the same Worker; adding an app is a D1 mutation, not a deploy. Statelessness,
the two scope gates, the `@tedix/db` boundary, and cache discipline are in
`apps/mcp/AGENTS.md`; the module map is `apps/mcp/README.md`.

## Invariants

- **One shared Worker.** No per-app Workers, no dispatch namespace, no Worker
  Loader runtime per tenant. Custom UI is `apps/mcp-ui` driven by
  `app_tools.config.layoutSpec`, never a per-app bundle.
- **Thin edge.** App/tool CRUD and source-of-truth reads go through `apps/api`
  oRPC. Direct D1 is limited to edge enforcement (tenant resolution, the
  `mcp_tasks` ledger, inline x402 payment gating).
- **The platform's own apps use the customer code path and schema.**
- **Full-app upstream proxying is disabled.** The `mcp` transport forwards only
  a forked tool row; `upstreamMcpUrl` with no tool rows is rejected.

## Protocol

Baseline: MCP SDK v2 and the `2026-07-28` revision. Tedix-owned endpoints are
modern-only: they reject `initialize` and require `MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name`, and the required `_meta` keys (`-32022` unsupported
version, `-32020` header/`_meta` mismatch, `-32021` missing client extension).
Non-obvious choices:

- First-party oRPC non-object results use a `{ data: value }` envelope in both
  `outputSchema` and `structuredContent`.
- List/read/discover results carry `ttlMs: 60000`, `cacheScope: "private"`:
  private cache hints, not ETags.
- Resource misses return JSON-RPC `-32602`, never empty contents.
- `resultType: "task"` goes only to callers advertising the Tasks extension;
  generic async tools use the `mcp_tasks` table plus a workflow.
- On `-32020`, clients refresh `tools/list` and retry the un-executed call once.
- `subscriptions/listen` is the one stateful path:
  `McpSubscriptionDurableObject` (`apps/mcp/src/subscriptions.ts`) streams
  task and list-change notifications over SSE.
- Elicitation is form mode only; autonomous tedis cannot satisfy URL mode's
  human-consent requirements.

### Dual-era upstream proxy

External upstreams are called through the SDK v2 `Client`
(`apps/mcp/src/mcp/upstream-mcp-client.ts`) with `versionNegotiation: 'auto'`:
`server/discover` first, then the 2025 `initialize` handshake. A 5xx or dropped
probe is retried once as a legacy handshake; a 401/403 stays an auth failure.
The era verdict is remembered per endpoint (10 minutes, 100 entries, evicted on
failure), so a warm modern call is one request and a warm legacy call is three.
`tools/call` is never re-sent by the SDK; the `-32020` retry and
`input_required` rounds stay explicit because the upstream executed nothing.

apps/api's calls to Tedix's own MCP surfaces use the same client pinned to
`2026-07-28` (`apps/api/src/lib/first-party-mcp.ts`). The two raw relays that
must pass `resultType: "task"` and `tasks/*` answers through untouched (the OS
widget proxy and the skill-runtime bridge) use `bindModernMcpRequest()`
(`packages/mcp/src/protocol.ts`), because the SDK client rewrites those
results. `upstream_protocol` analytics rows record calls per era; a legacy
branch is removable only when usage and inventory are both zero.

## Request Path

- **Hostname.** `{app}.mcp.tedix.dev` → slug; a custom domain →
  `apps.getByDomain`. Header precedence is `X-Original-Host`,
  `X-Forwarded-Host`, `X-Tedix-Host`, `Host`. In development an explicit
  `X-Tedix-Host` wins, because the Vite dev server sets `X-Forwarded-Host` on
  every request (`resolveRequestHostname` in `apps/mcp/src/hostname.ts`).
- **API deadline.** Each attempt to `apps/api` has a deadline
  (`UPSTREAM_ATTEMPT_TIMEOUT_MS`, `apps/mcp/src/upstream.ts`) and at most one
  retry; a final timeout returns a retryable 503 and evicts the in-flight entry
  so one stuck call cannot pin every later request for that app.
- **App cache.** `getAppContext` (`apps/mcp/src/mcp/server-factory.ts`) caches
  per isolate for 60 s. A raw SQL change to `apps.metadata` skips invalidation;
  change config through `apps.update_app` so it is validated and normalized.
- **Auth failures.** Missing scopes return `403 insufficient_scope`; no auth on
  a `hybrid` app returns 401 with `WWW-Authenticate` so the client can start
  OAuth. See [Auth](../platform/auth.md).

## App Tiers

| Tier                 | Tools                                                                      | Purpose                                                    |
| -------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Platform base app    | Own D1 `app_tools` rows                                                    | Canonical tool definitions; schema sync targets these rows |
| Tenant/project proxy | Zero rows; points at a base app via `source_app_id` and/or `aggregateApps` | Per-org credential routing plus visibility/policy overlay  |
| Custom app           | Own D1 rows                                                                | Branded customer apps, optionally with bespoke widgets     |
| Aggregator           | `aggregateApps` / `aggregateTedis`, `codeMode: true`                       | Org-wide bundle collapsed into one `code` tool             |

Copied base rows on a proxy are drift: delete them. Easy-to-confuse
`mcpConfig` fields:

- `connectionProviderId` / `connectionScope(s)`: credential overlay. On a base
  app it is the default for its own tools; on a proxy it overrides the
  aggregated base tools without copying them. A host's connection settings are
  applied to its aggregate entries before resolution
  (`applyHostConnectionDefaultsToAggregateEntries`, `apps/mcp/src/index.ts`),
  so a proxy never serves the base app's credential. A `connectionScope`
  without a provider id applies only to the host's own tools.
- `aggregateApps[].slug`: another app, resolved recursively over D1 rows.
  Explicit `toolIds` / `endpointPrefixes` stay restrictions at every level, and
  a parent `readOnly` applies to all descendants.
- `aggregateTedis[].slug`: a tedi in the same org under a Code Mode namespace.
  It is a curated bridge (`apps/mcp/src/mcp/aggregate-tedis.ts`), not live
  discovery; keep its schemas in sync with the projected contracts.

The platform operator bundle prepends the admin app. Admin tools are real D1
rows projected by tool-schema sync; `platform-operator-tools.ts` only defines
the allowlist, ids, annotations, and widget overlays.

`apps.provision` registers a Descope AIH MCP server only with
`registerDescopeAih: true`: use it for endpoints clients connect to directly
(aggregators, the admin app), not for base apps and proxies. New organizations
get their gateway from `ensureOrganizationUnifiedGateway()`
(`apps/api/src/lib/organization-mcp-gateway.ts`) before they become launchable.

Proxies resolve credentials from the caller's tenant (`dct`) plus the overlay.
The MCP-to-API credential hop forwards tool id, verified actor, and scopes and
requires `connections.execute`; service-binding trust alone never releases a
provider credential.

## Tool Execution

`ToolHandler` (`apps/mcp/src/mcp/handler.ts`) executes every row by
`config.transport`: `rpc`, `rest`, `external`, `mcp`, `code`, `catalog`.
`input_schema` must be a full root-object JSON Schema, not a property map.

- **Output shaping** (`buildStructuredContent`): `responseMap`,
  `responseTransforms`, `arrayLimits`, `stripFields`, `staticOutput`;
  `modelSummaryTemplate` renders model-visible text while hosts keep the full
  `structuredContent`. Success text over 4,000 characters is truncated with a
  pagination hint; errors and `structuredContent` never are.
- **Timeouts.** Internal calls default to 15 s (`DEFAULT_INTERNAL_TIMEOUT_MS`);
  `INTERNAL_TIMEOUT_FLOORS_MS` raises known slow endpoints. The public edge
  caps a request near 100 s, so longer work must return an MCP task.
- **Identity headers** on the `API_SERVICE` binding: `X-Tedix-Tedi-Id` (hint),
  `X-Tedix-Tedi-Scopes` (a grant: `platform:admin` makes the tedi a platform
  principal), `X-Tedix-Mcp-Tool-Id` (authorizes that one tool for a scoped
  tedi), `X-Tedix-Acting-User` (hint). Public ingress strips every internal
  trust header (`INTERNAL_TRUST_HEADERS`, `packages/worker-kit/src/request-auth.ts`);
  binding trust comes from the named `InternalEntrypoint`, never Host or IP.
- **Risk policy.** `app_tools.meta["com.tedix/policy"]` pairs `riskTier` with
  `blastRadius`: `read`/`none` (no budget), `bounded_write` (30/min per org,
  actor, app, tool), `high_impact_write` and `external_side_effect` (5/min plus
  an approval gate). Contract validation rejects other pairs; missing policy is
  `unclassified`, never rewritten to `read`. A rate-limit denial records
  `tool_rate_limited` and runs no handler.
- `destructiveHint: true` also triggers server-side elicitation where the
  client supports it.

## Aggregate Resolution

Aggregators bundle dozens of apps, so resolution degrades rather than hangs
(`apps/mcp/src/index.ts`):

- Entries are prefetched in chunks of 20 via `apps.getBySlugsWithTools`.
  Results are positional, so `app: null` stays distinct from `tools: []`. The
  prefetch only seeds caches; on failure entries resolve one at a time. Nested
  aggregates' late requests are coalesced into one batch.
- Requests join an in-flight rebuild only up to `AGGREGATE_DEADLINE`; the
  rebuild keeps running and fills the caches. Wedged shared promises are
  evicted after budgets sized above the sum of inner budgets.
- A surface with failed entries is `degraded` and never cached (cache tiers:
  [Code Mode](codemode.md#aggregate-cache)).
- Cache keys include the deploy version id, and tool-schema sync rolls a global
  activation epoch before purging snapshots. The epoch lives in R2; when
  `MCP_AGGREGATE_EPOCH_KV_ID` names a KV Instant namespace (private beta,
  `mode: "instant"`), requests prefer that pointer and fall back to R2.
  Invalidation writes R2 first; if the Instant write and the cleanup of the old
  pointer both fail, the purge reports failure rather than claiming the new
  generation is active. Leave the variable unset without beta access.

## Tedi MCP Server

Every tedi exposes `{slug}.tedi.tedix.dev/mcp` on the same transport. Tools are
registered in `apps/tedi-runtime/src/mcp-mount.ts` (conversation tools,
`run_tedi_turn`, peer messaging, workspace/repo, workstation, artifacts,
`cron`, approvals). Scopes follow `tedi:<category>.<action>`.

- Transcript reads come from `tedi_runtime_events`, not runtime-local buffers.
  `run_tedi_turn` is idempotent on `client_request_id`.
- With `LOADER`, all tools collapse into one `code` tool under `codemode`;
  without it, or if discovery fails, they register individually.
- Memory, Work Item, email, browser, and provider tools are not static edge
  tools; they reach a tedi through assigned apps and Code Mode.
- As a client, a tedi sees only apps assigned to it (FGA). Connections use
  `packages/mcp-client-core/src/client-manager.ts`; readiness needs only
  `tools/list`. Cancellation stops the local request; it does not prove the
  upstream rolled back.

## Telemetry

- Inbound tool metrics go to Analytics Engine (`session_init`, `tool_call`,
  `prompt_get`, `code_exec`, `resource_read`, `upstream_protocol`); Code Mode
  runs share an `executionId` between `code_exec` and inner `tool_call`s.
- `tool_call`, `prompt_get`, and `code_exec` also write D1 `audit_events` via
  `emitMcpAuditEvent()`, including risk tier, blast radius, and denial reason.
- A tedi's outbound calls are `tool.*` events in `tedi_runtime_events`
  (`packages/mcp-client-core/src/runtime.ts`,
  `apps/tedi-runtime/src/native-tool-ledger.ts`).

MCP is a tool, auth, and resource edge. Chat state belongs to the
[cognitive runtime](../cognition/runtime.md).
