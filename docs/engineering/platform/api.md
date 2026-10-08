---
summary: "oRPC vs public REST boundary, the API client, tool schema sync, OpenAPI import, and API traps"
read_when:
  - Changing API contracts, routers, or OpenAPI generation
  - Checking internal RPC versus public REST behavior
  - Changing tool schema sync or OpenAPI tool import
title: "API platform"
---

# API Platform

`apps/api` serves one contract tree two ways: typed oRPC at `POST /rpc/*` for
Tedix clients, Workers, and MCP, and a curated REST/OpenAPI surface at `/v1/*`.
Contract-first rules, lazy routers, error codes, and the two authorization
planes are in `apps/api/AGENTS.md`; contracts are in
`packages/api-contract/src/contracts/`.

## RPC vs Public REST

REST is **opt-in per operation**: a procedure is published only when it carries
the `REST` metadata tag and is listed, with a justification, in
`apps/api/src/rpc/public-rest-operations.ts`. The same predicate drives `/v1/*`
and `/openapi.json`, so presence in `apiRouter` or `apiContract` publishes
nothing, and an RPC procedure or admin MCP tool is not necessarily available
over REST.

The public surface is the customer control plane: apps (CRUD, tools, adapters,
catalog browse, installs, templates), tenants (organization and membership
lifecycle, billing self-service, usage/cost and audit reads), and tedi
identity/status with app assignments. Credentials, runtime logs and sessions,
Work Items, connections, payments, kernel/memory and browser execution, policy
internals, and jobs stay RPC/MCP-only.

REST verbs follow HTTP semantics, but query-shaped operations stay `POST` when
input is large, sensitive, or deeply structured, or when the call creates
billing, audit, workflow, or credential state. Removed REST routes are not
kept as aliases. The configured `API_URL`, not the request host, owns the
`service-desc`/`service-doc` links.

Handler plugins: do not add `CompressionPlugin` (the CDN compresses) or
`SimpleCsrfProtectionPlugin` (JSON RPC already forces a CORS preflight).

## API Client

`@tedix/api-client` owns link construction, serialization, retries, and
internal caller headers. Workers call `getInternalApiClient(env)` over
`API_SERVICE`; runtime-selected procedures use `callRpc()`, which keeps HTTP
status and detail in `RpcCallError`. `RetryLinkPlugin` defaults to zero retries
because every RPC is a POST that may write; opt in per call only for reads or
idempotency-keyed operations.

The `ApiRouter` type can lose inference through middleware chains
(`UseQueryOptions<{}>`); product clients type against the pure contract.

## Tool Schema Sync

`toolSchemaSync.preview` / `run` regenerate oRPC-backed `app_tools` rows from
contracts (`apps/api/src/services/tool-schema-sync.ts`). MCP validates results
against the D1 rows, not the Worker bundle, so rows must be reconciled after an
API release. Non-object results are wrapped as `{ data: value }` in both
`outputSchema` and `structuredContent`.

Generated ids are verb-first snake_case with the router slotted by role, never
as a trailing suffix:

1. Bare verb: router becomes the object — `skills/list` → `list_skills`.
2. Preposition: router before it — `skills/listByApp` → `list_skills_by_app`.
3. Procedure already names its object: router dropped —
   `tedis/rotateAccessKey` → `rotate_access_key`.
4. Router word already present: unchanged —
   `memoryGraph/searchMemoryGraph` → `search_memory_graph`.
5. Cross-router collision: router after the verb — `workflows/getStatus` →
   `get_workflows_status`.

`toolIdOverrides` always wins; `regenerateToolIds: true` renames existing rows.

## OpenAPI Tool Import

`OpenApiSyncWorkflow` is the only write path for generated REST tools. It
writes one `external` `app_tools` row per operation and persists
`metadata.mcpConfig.openApiSync` so refreshes replay the same source.

- With `connectionProviderId`, credential headers are removed from tool input
  schemas so the model never supplies secrets.
- `x-tedix-injected-arguments` declares MCP-only arguments filled from trusted
  runtime context. It is not upstream authorization; collisions with real
  parameters are rejected.
- Provider-specific UI lives in sync config (`widgetDefaults`,
  `widgetOverrides`), not widget source.

Catalog operator routes need a service binding, an API key or M2M token with
`catalog:manage`, or a platform-admin user. Tenants with `apps:update` and
`catalog:manage` may import only into their own non-proxy OpenAPI base app.

## Skill Workflow Runs

Cloudflare Workflows owns execution state; Tedix owns pinned source,
capabilities, identity, and the `skill_runs` records. Terminal projection is
epoch-fenced (`expectedExecutionEpoch`), and run reads carry `ENVIRONMENT`
because local and production can share D1 but not Workflow bindings. Active or
ambiguous runs cannot be revoked. Mutating calls accept `confirmDestructive`
and `reason` for stateless MCP callers. See [Skills](../cognition/skills.md).

## Trace Context

Inbound calls resolve a trace id from W3C `traceparent`, then MCP
`params._meta.traceparent`, then `X-Trace-Id`, else a new UUID
(`@tedix/mcp-shared/trace-context`). Episode joins use the non-generating
parser so records attach to an existing episode. `tedi_runtime_events` and
`kernel_runtime_events` carry an indexed `trace_id`.

## Latency

A warm authenticated request is mostly serial D1 round trips in `withAuth`
before the handler's own read; remove round trips rather than rewriting the
handler's query. Read through `context.db` so calls stay inside the request's
`first-primary` D1 session.
