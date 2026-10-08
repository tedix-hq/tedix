---
summary: "Tedix multi-tenant MCP runtime: one shared Worker, D1-configured apps and tools, app tiers, routing, scopes, and telemetry"
read_when:
  - Changing apps/mcp runtime behavior or per-app routing
  - Updating D1-backed MCP tool loading, app tiers, or schema metadata
  - Checking tedi MCP server scopes, resources, or runtime topology
title: "MCP runtime"
---

# MCP Runtime

`apps/mcp` is one stateless, multi-tenant MCP edge. Every app — platform base
apps, tenant proxies, branded customer apps, and aggregators — is a set of D1
rows served by the same Worker. Adding an app is a D1 mutation, not a deploy.
Module map: `apps/mcp/README.md`.

## Invariants

- **One shared Worker.** No per-app Workers, no Workers for Platforms dispatch
  namespace, no Worker Loader runtime per tenant. Each request builds an SDK v2
  `McpServer` through `createMcpServer()` (`packages/mcp/src/server.ts`) and
  serves it with `mountMcp()` (`packages/mcp/src/transport.ts`).
- **Config-driven.** Tools, prompts, widgets, CSP, scopes, and server identity
  come from D1. Custom UI is React in `apps/mcp-ui` driven by
  `app_tools.config.layoutSpec`, never a per-app bundle. There are no per-tool
  handler files.
- **Thin edge.** App/tool CRUD and source-of-truth reads go through `apps/api`
  oRPC. Direct D1 access is limited to edge enforcement: tenant resolution, the
  `mcp_tasks` ledger, and inline x402 payment gating.
- **Contract-first.** Schemas and contracts live in `@tedix/api-contract`.
- **Same server for Tedix and customers.** The platform's own apps use the
  same code path and schema as customer apps.
- **Never point `upstreamMcpUrl` at another `*.mcp.tedix.dev` app** in the same
  Worker/zone.

## Protocol Alignment

Baseline: MCP SDK v2 (`@modelcontextprotocol/{client,core,server}`) and the
`2026-07-28` protocol revision.

| Area                           | Tedix behavior                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON Schema 2020-12            | `app_tools.input_schema` / `output_schema` store MCP JSON Schema objects with `schema_dialect = "json-schema-2020-12"` plus provenance columns for drift checks.                                                                                                                                            |
| `outputSchema`                 | D1 `output_schema` is advertised as `outputSchema`. Upstream MCP schemas keep any JSON shape; first-party oRPC non-object results use the SDK adapter's `{ data: value }` envelope.                                                                                                                         |
| `structuredContent`            | Returned beside `content`; Code Mode preserves inner structured output; widget hosts prefer it over parsing text.                                                                                                                                                                                           |
| `resultType`                   | `mountMcp()` adds `resultType: "complete"` to successful results and preserves `input_required` / `task`.                                                                                                                                                                                                   |
| `server/discover`              | Tedix-owned endpoints are modern-only: they reject `initialize` and require `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, `Mcp-Name` on named-target methods, and the required `_meta` keys. Errors: `-32022` unsupported version, `-32020` header/`_meta` mismatch, `-32021` missing client extension. |
| `ttlMs` / `cacheScope`         | List/read/discover results carry `ttlMs: 60000`, `cacheScope: "private"`. These are private cache hints, not HTTP ETags.                                                                                                                                                                                    |
| MCP Apps                       | See [MCP Apps](apps.md).                                                                                                                                                                                                                                                                                    |
| Skills over MCP                | App servers expose `skill://.../SKILL.md`, supporting file resources, and native `skills/list` / `skills/get`.                                                                                                                                                                                              |
| Resource not found             | Misses return JSON-RPC `-32602`, never empty contents.                                                                                                                                                                                                                                                      |
| Tasks                          | `tasks/get`, `tasks/update`, `tasks/cancel` are advertised only when task handlers are mounted. Only callers that advertise the Tasks extension receive `resultType: "task"`. Generic async tools use the `mcp_tasks` table and a workflow. The SDK v1 `taskSupport` / `tasks/result` path is removed.      |
| `completion/complete`          | Advertised only when a handler is mounted; results capped at 100 values. Providers complete tedi ids, namespaces, session keys, and conversation ids.                                                                                                                                                       |
| `x-mcp-header` / `Mcp-Param-*` | Client and gateway mirror schema-annotated arguments into `Mcp-Param-*` headers. On `-32020` they refresh `tools/list` and retry the un-executed call once.                                                                                                                                                 |
| `subscriptions/listen`         | The transport stays stateless; `apps/mcp` routes the method to `McpSubscriptionDurableObject` (`apps/mcp/src/subscriptions.ts`), which streams task and list-change notifications over SSE.                                                                                                                 |
| Roots, Sampling, Logging       | Not advertised by modern Tedix clients.                                                                                                                                                                                                                                                                     |
| Elicitation                    | Form mode only. Autonomous tedis cannot satisfy URL mode's human-consent requirements, so they do not declare it.                                                                                                                                                                                           |

The external-upstream proxy is deliberately dual-era. It calls through the SDK
v2 `Client` (`apps/mcp/src/mcp/upstream-mcp-client.ts`) in
`versionNegotiation: 'auto'` mode: `server/discover` first, the 2025
`initialize` handshake when the upstream does not speak `2026-07-28`. A probe
answered with a 5xx or a dropped connection is retried once as a legacy
handshake on a fresh connection; a 401/403 probe answer stays an auth failure.
The era
verdict from a successful connect is remembered per upstream endpoint (10
minutes, 100 entries, evicted on failure) and replayed as `connect({ prior })`,
so a warm call to a modern upstream is one `tools/call` and a warm legacy call
is three requests. The first-party tedi and Docs bindings are seeded modern and
never probe. `tools/call` is never re-sent by the SDK; the proxy's own `-32020`
retry and deterministic `input_required` rounds stay explicit, because in both
the upstream executed nothing. apps/api's calls to Tedix's own MCP surfaces
(Home direct reads and approved writes, Docs, the health probe, the eval
workflow) go through the same SDK `Client` pinned to `2026-07-28`
(`apps/api/src/lib/first-party-mcp.ts`): the known modern verdict is adopted
without a probe, except where the caller exists to verify `server/discover`.
The two raw relays that must pass `resultType: "task"` results and `tasks/*`
answers through untouched — the Tedix OS widget proxy and the skill-runtime
bridge — bind requests with `bindModernMcpRequest()`
(`packages/mcp/src/protocol.ts`), because the SDK client rejects or rewrites
those results. `packages/mcp-client-core` is the long-lived client that also
owns sessions, auth, elicitation, Tasks, and reconnect.

## Request Flow

```text
AI host
  → {app}.mcp.tedix.dev/mcp (or a custom MCP domain)
  → apps/mcp (mountMcp, stateless)
  → apps/api (oRPC over service binding)
  → apps/mcp-ui (widget HTML + theming)
```

Cross-cutting concerns are applied at tool registration (for example
`wrapToolCallTelemetry` in `apps/mcp/src/mcp/tool-registration.ts`) and at the
transport edge. There is no server middleware chain.

### Hostname resolution

- `{app}.mcp.tedix.dev` → app slug.
- Custom domain (`mcp.example.com`) → `apps.getByDomain`.
- Base-domain `.well-known` → hostname domain, then `DEFAULT_APP_SLUG`.
- Local dev → `X-Tedix-Host` simulates a subdomain.

Header precedence: `X-Original-Host`, `X-Forwarded-Host`, `X-Tedix-Host`,
`Host`, then the URL hostname. In development an explicit `X-Tedix-Host` is
checked first, because the Vite dev server sets `X-Forwarded-Host` on every
direct request (`resolveRequestHostname` in `apps/mcp/src/hostname.ts`).

No MCP Durable Object is involved in request serving. Concurrent app loads are
deduplicated with per-isolate in-flight promises. Each upstream attempt to
`apps/api` has a deadline (`UPSTREAM_ATTEMPT_TIMEOUT_MS` in
`apps/mcp/src/upstream.ts`) and at most one retry; a final timeout returns a
retryable 503 and evicts the in-flight entry, so one call that never settles
cannot pin every later request for that app.

### App context

App context is loaded via `apps.getBySlugWithTools` / `apps.getByIdWithTools`
and cached by `getAppContext` (`apps/mcp/src/mcp/server-factory.ts`) for
`CACHE_TTL_MS` (60 s) per isolate. Server name and version come from
`apps.metadata.mcpConfig`. A raw SQL change to `apps.metadata` skips cache
invalidation; change app config through the `apps.update_app` tool so it is
validated and normalized.

### Scope enforcement

Before building the per-request server, the edge checks
`mcpConfig.toolScopes` (and `enforcePolicies`) against the caller's auth type
and scopes:

- `oauth`, `tedi`, `external_agent`: missing scopes return
  `403 insufficient_scope`.
- `service` (internal service binding): scope check bypassed.
- No auth and `authMode === "hybrid"`: structured `401` with
  `WWW-Authenticate` so the client can start OAuth.

Auth modes, scope derivation, and credential resolution: [Auth](../platform/auth.md).

## App Tiers

Every app has an `organizationId`. The platform's own apps live in the
platform organization and are shaped exactly like customer apps.

| Tier                 | Owner                | Tools                                                                      | Purpose                                                                                                                         |
| -------------------- | -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Platform base app    | Platform org         | Own D1 `app_tools` rows (upstream catalog tools are forked once)           | Canonical tool definitions for a provider (`notion`, `firecrawl`, `github`, …). Schema sync and drift checks target these rows. |
| Tenant/project proxy | Customer org         | Zero rows; points at a base app via `source_app_id` and/or `aggregateApps` | Per-org/project credential routing plus visibility, assignment, and policy overlay (`notion-acme`, `firecrawl-acme`).           |
| Custom app           | Customer org         | Own D1 rows (often `transport: "rpc"`)                                     | Branded customer-facing apps, optionally with bespoke widgets.                                                                  |
| Aggregator           | Usually customer org | Composes other apps via `aggregateApps`; `codeMode: true`                  | Org-wide bundle collapsed into one `code` tool (`acme-unified`).                                                                |

Two other axes are independent of the tier: UI surface (none, json-render
`layoutSpec`, or a bespoke `@tedix/widget-ui` component) and distribution
(`apps.visibility`, `mcpConfig.authMode`). Every combination runs on the same
Worker.

Do not copy a base app's rows into a tenant proxy. If copied rows appear on a
proxy, treat them as drift and delete them.

### `mcpConfig` fields that are easy to confuse

| Field                                                           | Meaning                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connectionProviderId` / `connectionScope` / `connectionScopes` | Runtime credential overlay. On a base app it is the default for its own tools; on a proxy it overrides the aggregated base tools without copying them. |
| `aggregateApps[].slug`                                          | Reference to another Tedix app. Resolves recursively over D1 rows while keeping the caller's overlay.                                                  |
| `aggregateTedis[].slug`                                         | Reference to a tedi in the same org, exposed under a Code Mode namespace (`cto`, `cmo`). Calls go to `{slug}.tedi.{domain}/mcp` with AIH auth.         |

```jsonc
// notion-acme — tenant proxy
{
  "connectionProviderId": "notion",
  "connectionScope": "tenant",
  "authMode": "authenticated",
  "aggregateApps": [{ "slug": "notion" }]
}

// acme-unified — aggregator
{
  "aggregateApps": [{ "slug": "notion-acme" }, { "slug": "firecrawl-acme" }],
  "aggregateTedis": [{ "slug": "cto", "namespace": "cto" }],
  "codeMode": true
}
```

When a host declares its own `connectionProviderId`, its connection settings
are applied to its aggregate entries before resolution
(`applyHostConnectionDefaultsToAggregateEntries` in `apps/mcp/src/index.ts`),
so a proxy never serves the base app's credential. A host-level
`connectionScope` without a provider id applies only to the host's own tools.

`aggregateTedis` exposes a curated bridge (`apps/mcp/src/mcp/aggregate-tedis.ts`),
not live discovery of every tedi tool; keep its input schemas in sync with the
projected oRPC contracts. Set `surface: "collaboration"` for a narrower
read/chat surface. `aggregateApps` and `aggregateTedis` are resolved by
different paths.

The platform operator bundle always prepends the admin app before its
configured `aggregateApps`. Admin tools are real D1 rows projected from oRPC
contracts by tool-schema sync; `apps/mcp/src/mcp/platform-operator-tools.ts`
only defines the allowlist, stable tool ids, annotations, and widget overlays
for that projection.

### Provisioning

`apps.provision` creates the D1 app row. It registers a Descope AIH MCP server
only with `registerDescopeAih: true` — use that for endpoints clients connect to
directly (aggregators, the admin app), not for base apps and proxies consumed
through an aggregator.

| Pattern        | Defaults                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------- |
| `materialized` | `authMode: "authenticated"`, `codeMode: false`; catalog sync writes the base tool rows.      |
| `tenant-proxy` | Zero tools, `source_app_id` / `aggregateApps` to a base app, plus connection/policy overlay. |
| `customer`     | `authMode: "authenticated"`, empty `toolScopes`, own D1 tools.                               |
| `aggregator`   | `codeMode: true`, broad capability-scope placeholders.                                       |

Patterns are defaults; explicit `mcpConfig` wins. New organizations get their
Code Mode gateway from `ensureOrganizationUnifiedGateway()`
(`apps/api/src/lib/organization-mcp-gateway.ts`), which creates the app row and
AIH resource before the organization becomes launchable.

Tenant proxies resolve credentials from the caller's tenant (JWT `dct` claim)
plus the proxy overlay, so the same base tools hit a different Token Vault
entry per org. The MCP-to-API credential hop forwards the tool id, the verified
actor, and the caller's scopes; the API requires `connections.execute` for it.
Service-binding trust alone never releases a provider credential.

## Config-Driven Tools (D1)

Three tables drive the surface:

- `apps` — identity and metadata (branding, `mcpConfig`, capabilities).
- `app_tools` — tool definitions: schemas, annotations, icons, `_meta`, widget
  routing, transport config, and schema provenance.
- `app_tool_csp_domains` — per-tool CSP overrides.

A few tools are registered at server init instead: `get_info` and
`__track_widget_analytics`. App skills (`list_skills`, `read_skill`, `skill://`
resources, `skills/list`, `skills/get`) are registered when the app has skill
rows. Skill lifecycle: [Skills](../cognition/skills.md).

### Handler branches

`apps/mcp/src/mcp/handler.ts` dispatches on `toolTypeId`:

| `toolTypeId` | Purpose                                                  |
| ------------ | -------------------------------------------------------- |
| `rpc`        | Call an oRPC/REST endpoint described in D1 config        |
| `memory`     | Brain memory operations ([Brain](../cognition/brain.md)) |
| `search`     | Product/listing search through adapters → `LayoutItem[]` |
| `content`    | Content-source search and answers                        |
| `adapter`    | Generic adapter federation → `LayoutItem[]`              |
| `prompt`     | Registered as an MCP prompt, not a tool                  |

### Transports

`config.transport` is separate from `toolTypeId`:

| Transport  | Behavior                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `rpc`      | `ApiToolHandler` calls `apps/api` over the `API_SERVICE` binding.                                              |
| `mcp`      | Forwards only this forked tool to `config.mcpServerUrl`; auth from Token Vault. Full-app proxying is disabled. |
| `external` | Maps `config.endpoint` to a third-party REST API with per-org credentials.                                     |

Read-only research tools should federate provider data rather than copy it.
`config.sourceProvenance` attaches the requested URL, provider docs, caller
identity, trace ids, and query time to the structured result; credentials never
enter it. `config.pathParamCase` normalizes path casing when an OpenAPI enum
and its wire path disagree.

OpenAPI import runs as a workflow (`catalog.run_openapi_import`). It writes
input/output schemas, annotations, provenance, and default widget metadata;
removes credential-like headers from model-facing input schemas; and turns
multipart file parameters into objects accepting `content`, `data`, or
`base64` bytes. Use `includePathPrefixes` / `excludePathPrefixes` /
`stripPathPrefixes` to constrain mixed vendor specs.

### RPC tool config

```json
{
	"toolTypeId": "rpc",
	"config": {
		"endpoint": "apps/list",
		"transport": "rpc",
		"method": "POST",
		"paramMap": { "appId": "appId" },
		"staticParams": { "limit": 50 },
		"responsePath": "json",
		"responseFormat": "raw"
	},
	"inputSchema": {
		"type": "object",
		"properties": { "appId": { "type": "string", "description": "App UUID" } },
		"required": ["appId"],
		"additionalProperties": false
	}
}
```

`input_schema` must be a full JSON Schema object with `type: "object"`, not a
flat property map.

Output shaping in `buildStructuredContent`: `responseMap`,
`responseTransforms` (`{field.path}` templates), `arrayLimits`, `stripFields`,
and `staticOutput`. `modelSummaryTemplate` renders the model-visible text from
the shaped output (with `{count:field.path}` for array lengths) while hosts keep
the full `structuredContent`. Success text over 4,000 characters is truncated
with a hint about pagination and field selection; errors and
`structuredContent` are never truncated by this rule.

### Execution context

Handlers receive a `ToolExecutionContext` with `appId`, `app`, `env`,
`config`, `toolId`, `requestId`, and `callerIdentity`:

```typescript
callerIdentity?: {
	authType: "user" | "m2m" | "tedi" | "service" | "apiKey" | "oauth" | "anonymous";
	userId?: string;
	organizationId?: string;
	email?: string;
	clientId?: string;
	tediId?: string;
	scopes?: string[];
	skillRunId?: string; // set when the caller is the skill runtime
	skillId?: string;
};
```

### Internal identity headers

On the `API_SERVICE` binding, `handler.ts` stamps the caller context that
`apps/api` reads on its service-binding branch:

| Header                | Meaning                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `X-Tedix-Tedi-Id`     | Acting tedi (identity hint).                                                                                                |
| `X-Tedix-Tedi-Scopes` | Scopes resolved from `tedis.mcp_capability_profile`. This is a grant: `platform:admin` makes the tedi a platform principal. |
| `X-Tedix-Mcp-Tool-Id` | Exact D1 tool id. With a scoped tedi identity, it authorizes that one tool without platform-wide rights.                    |
| `X-Tedix-Acting-User` | Human caller's user id (identity hint).                                                                                     |

These headers are trusted only on the service binding: public ingress strips
every internal trust header on every route (`INTERNAL_TRUST_HEADERS` in
`packages/worker-kit/src/request-auth.ts`), and binding trust comes from the
named `InternalEntrypoint`, never from a forwarded Host or missing client IP.

### Timeouts

Internal (`rpc`/`rest`) calls use `DEFAULT_INTERNAL_TIMEOUT_MS` (15 s) unless
`config.timeout` overrides it; `INTERNAL_TIMEOUT_FLOORS_MS` raises a
per-endpoint minimum for known slow endpoints (tedi lifecycle, Home/kernel,
voice, evals). The public edge still caps a request near 100 s, so work that
can exceed that should return an MCP task instead of holding the connection.
External-transport tools use the plain default.

### Risk policy

Classified tools carry `app_tools.meta["com.tedix/policy"]`, e.g.
`{"riskTier":"bounded_write","blastRadius":"single_resource"}`. Valid pairs:

| `riskTier`             | `blastRadius`                 | Enforcement                                                      |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `read`                 | `none`                        | No write budget.                                                 |
| `bounded_write`        | `single_resource` \| `tenant` | 30/minute rate budget per org, actor, app, and tool.             |
| `high_impact_write`    | `tenant` \| `multi_tenant`    | 5/minute budget; destructive approval gate.                      |
| `external_side_effect` | `external_system`             | 5/minute budget; approval gate; advertised with `openWorldHint`. |

Contract validation rejects other pairs. Missing or malformed policy is
reported as `unclassified`, never rewritten to `read`. Audit events record
`riskTier` and `blastRadius`; a rate-limit denial records `tool_rate_limited`
and runs no handler.

### Registration

`server-factory.ts` + `tool-registration.ts` register tools two ways:
widget tools via `registerDynamicTool()` (tool plus `ui://` resource) and
text-only tools via `registerTextOnlyTool()`. `registerAppPrompts()` registers
`toolTypeId: "prompt"` rows with `server.registerPrompt()`; `config.template`
uses `{{arg}}` substitution, and missing keys are left as-is.

### Annotations and `_meta`

`app_tools.annotations` maps to MCP `ToolAnnotations` (`readOnlyHint`,
`destructiveHint`, `openWorldHint`, `idempotentHint`). `destructiveHint: true`
also triggers server-side elicitation where the client supports it.

| Tool category        | `readOnlyHint` | `destructiveHint` | `openWorldHint` |
| -------------------- | -------------- | ----------------- | --------------- |
| Read/list            | `true`         | `false`           | `false`         |
| Create/update        | `false`        | `false`           | `false`         |
| Delete/restart/reset | `false`        | `true`            | `false`         |
| Publishes externally | `false`        | `false`           | `true`          |

Every tool also carries `com.tedix/*` `_meta` fields: `appSlug`, `toolTypeId`,
`hasWidget`, `widgetKey`, `widgetDescription`, and `transport` (`mcp` or
`external`; omitted for `rpc`).

## Code Mode

With `mcpConfig.codeMode: true`, tools collapse into one `code` tool grouped by
namespace (endpoint prefix, e.g. `apps/list` → `apps`).
`mcpConfig.codeModeNamespaces` is for semantic renames only; keep names the same
across servers so tedis can reuse what they learned. Execution model, sandbox,
and UI helpers: [Code Mode](codemode.md). Widget resources: [MCP Apps](apps.md).

## Aggregate Surface Resolution

Aggregators can bundle dozens of apps, so resolution is built to degrade rather
than hang (`apps/mcp/src/index.ts`):

- Entries are prefetched in batches through `apps.getBySlugsWithTools`
  (`AGGREGATE_PREFETCH_CHUNK` = 20, a memory bound). Results are positional, so
  `app: null` (missing) stays distinct from `tools: []`. The prefetch is only a
  cache seed; on any failure entries resolve one at a time.
- Nested aggregates discover their entries late, so prefetch requests are
  buffered for `AGGREGATE_PREFETCH_COALESCE_MS` and flushed as one batch.
- Requests join an in-flight rebuild only up to a deadline
  (`AGGREGATE_DEADLINE`); the rebuild keeps running and fills the caches.
- A surface with failed entries is marked `degraded` and is not cached.
- Shared in-flight maps evict wedged promises after
  `INTERNAL_TOOL_WEDGE_EVICT_MS` / `AGGREGATE_LOAD_WEDGE_EVICT_MS`, sized above
  the sum of the inner budgets.
- Durable cache keys include the deploy's version id, and tool-schema sync
  rolls a global activation epoch before purging snapshots, so new schemas are
  not served from stale caches. When `MCP_AGGREGATE_EPOCH_KV_ID` names a
  pre-created KV Instant namespace, requests prefer its tiny epoch pointer and
  fall back to the existing R2 marker on a missing, invalid, timed-out, or
  failed read. The binding is omitted when that variable is unset, so local
  development and accounts without private-beta access keep the R2/Cache API
  behavior unchanged. Invalidation writes R2 first; if the optional Instant
  write fails, it removes the old Instant pointer before continuing on R2. If
  that removal also fails, the purge reports failure instead of claiming that
  the new generation is active.

KV Instant is only a revision plane here. It stores
`aggregate-activation/v1/current`; sessions, ledgers, tool content, aggregate
schemas, and other frequently updated tenant state remain outside it. The
namespace must be provisioned with `mode: "instant"` before its id is supplied
to the Worker config. As of 2026-10-01, KV Instant is private beta, the
installed `@cloudflare/config` exposes the ordinary `bindings.kv({ id })`
attachment but no namespace-creation `mode` option, and Cloudflare documents no
public provisioning path beyond beta access. Live propagation proof therefore
requires an enabled account plus a namespace created through that beta surface;
without both, the optional binding must stay unset.

## Tedi MCP Server

Every tedi exposes `{slug}.tedi.tedix.dev/mcp` on the same `mountMcp()`
transport. Tools are registered in `apps/tedi-runtime/src/mcp-mount.ts` and
handled in `apps/tedi-runtime/src/do.ts`: conversation channel tools
(`conversations_list`, `conversation_get`, `messages_read`, `run_tedi_turn`),
peer messaging, `audit_memory_graph`, workspace/repo tools, workstation leases,
artifacts, `cron`, and assigned-resource reads. Scopes follow
`tedi:<category>.<action>`.

- Transcript reads come from the cognitive runtime ledger
  (`tedi_runtime_events`), not runtime-local buffers.
- `run_tedi_turn` queues a normal turn; `client_request_id` makes it idempotent.
- `permissions_list_open` / `permissions_respond` wrap
  `cognitiveRuntime.listApprovals` and record `approval.resolved`.
- With the `LOADER` binding, all tools collapse into one `code` tool under a
  flat `codemode` namespace; without it, or if discovery fails, tools register
  individually.

Memory, work-item, email, browser, and provider tools are not static tedi edge
tools. They reach a tedi through assigned MCP apps and Code Mode. Work Item
tools are a curated projection on the aggregate (`WORK_ITEM_TOOLS` in
`apps/mcp/src/mcp/aggregate-tedis-work-items.ts`); see
[Work Items](../cognition/work-items.md).

Resource templates:

| URI template                   | Content                       |
| ------------------------------ | ----------------------------- |
| `tedi://memory/facts/{domain}` | Memory facts by domain        |
| `tedi://memory/graph/{factId}` | Knowledge graph around a fact |
| `skill://{skillName}/SKILL.md` | Skill content                 |
| `tedi://rationale/{category}`  | Rationale chain by category   |
| `tedi://config/runtime`        | Current runtime configuration |

Peer tedis connect through Tedix MCP endpoints with M2M AIH auth or the
internal Durable Object mesh; only running tedis with a Descope MCP resource id
appear on external AIH surfaces.

### Tedi as MCP client

Tedis see only MCP apps assigned to them (FGA, with optional defaults from
`mcpConfig.assignmentConfig`). There are no raw connection tools such as
`mcp_connect`. Connections use the SDK v2 client
(`packages/mcp-client-core/src/client-manager.ts`) pinned to the modern
protocol. Readiness requires only `tools/list`; resources, prompts, and skills
load on explicit refresh. Deadlines propagate as `AbortSignal`. Cancellation
stops the local request; it does not prove the upstream operation was rolled
back.

## Telemetry and Audit

- **Inbound app tool metrics:** Analytics Engine, written by `apps/mcp`. Event
  types: `session_init`, `tool_call`, `prompt_get`, `code_exec`,
  `resource_read`, `upstream_protocol`. Each event carries `userId`, `tediId`,
  `clientId`, and `authType`. Code Mode runs get an `executionId` linking the
  `code_exec` event to its inner `tool_call` events.
- **Upstream protocol use:** `upstream_protocol` rows record successful calls by
  protocol era, app, tool, and first-party/external boundary. URLs,
  credentials, arguments, and results are never recorded. A legacy protocol
  branch is removable only when both usage and catalog inventory are zero.
- **Audit:** `tool_call`, `prompt_get`, and `code_exec` write D1
  `audit_events` via `emitMcpAuditEvent()` with actions such as
  `mcp.tool.execute` / `mcp.tool.error` and metadata including app, session,
  duration, error code, execution id, risk tier, blast radius, and denial
  reason.
- **Outbound tedi tool calls:** `executeTool` in
  `packages/mcp-client-core/src/runtime.ts` records `tool.started`,
  `tool.completed`, or `tool.failed` in `tedi_runtime_events`; native tools
  record the same kinds from `apps/tedi-runtime/src/native-tool-ledger.ts`.
  Read them through `cognitiveRuntime.listEvents`.
- Widget analytics go through the internal `__track_widget_analytics` tool.

MCP is a tool, auth, and resource edge. Chat state belongs to the cognitive
runtime ([Cognitive runtime](../cognition/runtime.md)), not to MCP.

## Related

- [MCP Apps](apps.md) — UI resources, CSP, host bridge
- [Code Mode](codemode.md)
- [Auth](../platform/auth.md) — auth modes, scopes, Token Vault, AIH
- [API](../platform/api.md) — oRPC contracts
- [Agent runtime](../tedi/agent-runtime.md)
