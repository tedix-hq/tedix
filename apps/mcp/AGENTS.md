---
summary: "apps/mcp scoped rules: per-request statelessness, config-driven D1 tools, the two scope gates, the @tedix/db exemption boundary, and cache discipline"
read_when:
  - Touching anything under apps/mcp/
  - Adding, gating, or renaming an MCP tool
  - Adding a module-level cache or a direct D1/Drizzle call in this app
title: "apps/mcp agent guide"
---

# apps/mcp Agent Guide

Root rules live in `/AGENTS.md`. Start with `apps/mcp/README.md` and
`docs/public/mcp-app-platform.md`; the execution and scope boundaries are below.

**Package-name trap first:** this app is `@tedix/mcp`. The shared package at
`packages/mcp` is published as `@tedix/mcp-shared` — importing `@tedix/mcp`
never gets you the shared auth/scopes/transport helpers.

## Stateless per request

A **new McpServer + transport is created per request** via `mountMcp()` from
`@tedix/mcp-shared/transport` (`src/index.ts` header, `src/mcp/server-factory.ts`).
Server instances are never cached — the MCP SDK enforces
one-transport-per-server via `isConnected()`. The existing subscription Durable
Object owns subscription delivery state; it never retains an MCP server or
transport. Other state that must survive a request lives in D1 or the
module-level caches below, and tool
handler closures capture per-request `ServerContext` (fresh caller identity).

## Tools are D1 rows, not files

Every app tool is a config-driven `app_tools` row executed by the universal
`ToolHandler` (`src/mcp/handler.ts` — six transports: rpc/rest/external/mcp/
code/catalog). The `catalog` transport runs configured `catalog/search` and
`catalog/describe` through the same authorized catalog projection with fresh
request context; it does not create a WorkerLoader. Native RPC descriptors
remain subject to their endpoint scope checks. Aggregate Connect lists only positively
opted-in native RPC/catalog rows from its current verified organization mounts.
`get_info.nativeOrganizations` describes each authorized gateway catalog pair;
the singular context remains unavailable until an organization is selected. Each
call independently verifies the mount and uses a fresh organization catalog view.
Descriptor eligibility never grants input-specific approval or Work admission. **No per-tool handler files.**
The few code-built platform tools under
`src/mcp/tools/` (widget authoring) are the deliberate exceptions,
not a pattern. `tool_id` names are verb-first snake_case (root rule "MCP Tool
Naming").

## Every registered tool needs a scope decision

Scope enforcement lives in **two** gates, and a tool is guarded by exactly one
of them:

- **Request-level edge gate:** `enforceMcpAccess()`
  (`src/index.ts:1803`) evaluates `resolvedApp.tools` before dispatch. Required
  scopes come from three config idioms: `mcpConfig.enforcePolicies` (Descope
  policy mode — `mcp:<tool_name>` via `toolToScope`), the explicit
  `mcpConfig.toolScopes` map, or per-tool `authRequired`
  (`extractRequiredScopes`, `src/auth-helpers.ts:556`).
- **Native dispatch gate:** Home tools and aggregated tools are merged into the tool set AFTER
  `enforceMcpAccess()` has run, so the request-level gate never sees them. They
  are gated by `enforceNativeToolScopeGate`
  (`src/mcp/tool-registration.ts:285`), scoped to
  `meta.source === "homeSurface"` and `config._aggregateNamespace`.

The rule that follows: a tool registered after the edge gate runs is unguarded
unless it gets its own dispatch-time check. Never add one without deciding
which gate owns it.

## The @tedix/db exemption boundary

`apps/mcp` is listed in root `vite.config.ts` `excludeFiles` (the oxlint
deny-by-default layer), but the **enforced** boundary is
`scripts/db-access-exceptions.json` + `bun run lint:db-access`: the only
approved owners here are `src/mcp/generic-task-store.ts` (the `mcp_tasks` edge
ledger) and `src/workflows/generic-tasks-workflow.ts`. A new direct-D1 or Drizzle
storage owner needs a reviewed manifest entry; operations within an existing
owner must stay within its documented responsibility, without call-count updates;
passing oxlint is not approval. Everything else reads through `apps/api`
(service binding) or the caches below.

## upstreamMcpUrl must never point back into this zone

Proxying another `*.mcp.tedix.dev` app (or `mcp.tedix.dev`) through
`mcpConfig.upstreamMcpUrl` loops the request back into this same Worker. The
write-guard rejects it for every principal in `assertTenantMcpConfigAllowed`
(`apps/api/src/rpc/routers/apps.ts:313`, the UPSTREAM_SAME_ZONE check at
~line 326). Use D1 tools or `mcpConfig.connectionLabel` instead.

## Module-cache discipline

Caches are isolate-lifetime `Map`s with TTLs and in-flight dedupe maps
(`src/resolution.ts`, `src/mcp/skill-cache.ts`, `src/index.ts`
`internalToolCache`/`aggregateSurfaceCache`). Two rules:

- A cache keyed by caller/token/client input must be **size-bounded** like the
  existing siblings: `userTediCache` (`src/index.ts:2435`, 200),
  `aihM2mClientScopeCache` (`src/auth-helpers.ts`, 100), `credentialTokenCache` (`src/mcp/handler.ts:300`, 500), the x402
  facilitator cache (`src/mcp/x402-facilitator.ts:14`, 16). TTL-only maps are
  acceptable only when the key space is app/org-bounded.
- Tool-schema projection explicitly rolls the aggregate activation epoch and
  purges durable snapshots. Isolates refresh that global marker within five
  seconds; ordinary D1 writes still have no automatic invalidation. Do not
  assume an arbitrary write is visible on the next request, cache longer, or
  add another cache layer on top.

## Verification

`bun run test:run` (never `bun test` — Workers aliases). Check live MCP
changes with a discovery call through the `tedix` CLI.
