---
summary: "Code Mode execution model: Dynamic Worker Loader sandbox, namespaced providers, compact discovery, result bounds, and inner-tool authorization"
read_when:
  - Updating MCP Code Mode, provider namespaces, compact types, or Dynamic Worker Loader behavior
  - Debugging the single code tool, sandbox execution, discovery, or inner-tool authorization
title: "MCP Code Mode"
---

# MCP Code Mode

Code Mode collapses a large MCP tool surface into one `code` tool. The model
writes an async JavaScript function against namespaced providers; the program
runs in an isolated Dynamic Worker (V8) with no network access, and every
namespace call dispatches back to the host over Workers RPC, where the normal
tool pipeline (auth, scopes, telemetry, timeouts, payment) runs.

Two surfaces use it:

| Surface                 | Where                                             | Provider model                                           |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| App / aggregate gateway | `apps/mcp` (`{slug}.mcp.tedix.dev`)               | D1 tool rows grouped into namespaces (`blog.*`)          |
| Per-tedi MCP            | `apps/tedi-runtime` (`{slug}.tedi.tedix.dev/mcp`) | Inner `McpServer` tools under one `codemode.*` namespace |

Activation on the gateway is per app: `codeMode: true` in D1
`apps.metadata.mcpConfig`. The per-tedi surface runs Code Mode whenever the
`LOADER` binding is present.

## Invariants

- **No network from the sandbox.** Executors are created with
  `globalOutbound: null`; the sandbox has no env, secrets, or filesystem.
- **Inner calls are re-authorized.** The outer `tools/call` authorizes `code`;
  each inner namespace call re-checks the resolved tool's scopes in
  `apps/mcp/src/mcp/codemode.ts` before `executeTool()` runs.
- **Only wired functions are callable.** Each namespace is a separate
  `ResolvedProvider`; the sandbox cannot reach anything not explicitly wired.
- **Call by exact callable.** Tools are called as the `namespace.tool(args)`
  path returned by discovery. `name`/`displayName` are labels, not call paths.
- **Namespaces must be named literally.** Request-scoped hydration parses the
  program for literal `namespace.tool(...)` references; computed access
  (`globalThis[ns]`) never hydrates and fails at call time.
- **Inner failures are data, not exceptions.** An inner operational failure
  returns a failed result the program can inspect; only program/runtime errors
  fail the outer `code` call. When any inner call fails (thrown or a swallowed
  `ok: false` envelope), the outer result also carries
  `failures: [{ tool, error }]` (≤10 entries, errors ≤300 chars).
- **Bounded retries.** Two identical failed calls exhaust the execution-local
  retry budget; the next identical call returns a blocked result instead of
  dispatching (`packages/tedi-codemode-core/src/failure-budget.ts`). The
  gateway and per-tedi adapters share this budget and the identical-call key.

Code Mode is a tool-compression pattern, not a separate protocol. Inner calls
may preserve `structuredContent` and MCP Apps resource metadata in the outer
envelope; async task handles remain an outer MCP server concern.

## Architecture

```
MCP client ── tools/call "code" ──▶ apps/mcp mountMcp() (per request)
                                        │ env.LOADER
                                        ▼
                               Dynamic Worker (V8, globalOutbound: null)
                                 blog.list_posts() ──RPC──▶ executeTool() ─▶ ToolHandler
                                 memory.search()   ──RPC──▶ (auth, telemetry, timeouts)
```

Key modules:

| File                                                         | Owns                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `apps/mcp/src/mcp/codemode.ts`                               | Namespace resolution, `discover` provider, compact types, providers |
| `apps/mcp/src/mcp/server-factory.ts`                         | `buildMcpServer()`: Code Mode vs standard registration              |
| `packages/tedi-codemode-core/src/register-codemode-tools.ts` | Per-tedi `code` tool, inner-server discovery, dispatch budgets      |
| `packages/tedi-codemode-core/src/run-stateless-code.ts`      | `runStatelessCodeMode()` → `DynamicWorkerExecutor.execute()`        |
| `packages/tedi-codemode-core/src/bounded-result.ts`          | `shapeBoundedCodeModeResult()` result bounds                        |
| `packages/api-contract/src/schemas/app.ts`                   | `McpConfigSchema` Code Mode keys                                    |

Tedix builds on `DynamicWorkerExecutor.execute(code, providers)` from
`@cloudflare/codemode`, not the package-level `runCode` helper.

## Gateway Namespaces

Namespaces are config-driven; there is no hardcoded map. Resolution order:

1. D1 `mcpConfig.codeModeNamespaces[prefix]` (semantic renames only).
2. camelCase root of the `config.endpoint` prefix (`memoryGraph/search` →
   `memory`, `mcpServer/list` → `mcp`).
3. `{source}__{tool}` prefix for proxied catalog tools
   (`github__search_repositories` → `github`).
4. `toolTypeId` for non-RPC tools.
5. `tools` catch-all.

Namespace governance metadata (owner, class, aliases, required scopes,
visibility, collision policy) lives in `@tedix/mcp-shared/namespace-governance`.
Built-in namespaces win collisions; duplicate config-derived callables are
rejected. Singular/plural peer aliases (`app`/`apps`, `tedi`/`tedis`) resolve
and are filterable but are not enumerated in unfiltered search.

### Workforce namespaces

Aggregator apps may expose tedis through `mcpConfig.aggregateTedis`; each entry
becomes a role namespace (`cto.*`, `cmo.*`) that preserves the tedi's identity,
memory, skills, and auth boundary. It is a curated bridge
(`apps/mcp/src/mcp/aggregate-tedis.ts`), not provider discovery — keep its list
and schemas in sync with the native tedi MCP tools and the projected oRPC
contracts. `surface: "collaboration"` selects a smaller chat/read surface.
`aggregateApps` is the equivalent for D1-backed app bundles.

```js
await cto.run_tedi_turn({
	session_key: "agent:main:main",
	text: "Review deployment risk.",
});
await cto.memory_search({ query: "MCP auth regression" });
```

### Built-in providers

- `discover` — search and inventory (below).
- `flow` — `flow.run` selects an available workflow tedi and validates runner arguments
  before recording a draft skill and starting the run; `flow.status`/`inspect`/`list` read the
  underlying workflow. It composes the `skills` and workforce namespaces; it is
  not a second dispatcher. `flow.run` takes `skillId` (rerun) or `source`, and
  optionally a verbatim `skillDoc` manifest.
- `codemode.__runtime()` — execution id, app/org, trace id, actor projection,
  and counts for log correlation. The authenticated tedi id is
  `runtime.actor.tediId` on the gateway and `runtime.tediId` on the per-tedi
  surface; portable code uses `runtime.actor?.tediId ?? runtime.tediId`.

`mcpConfig.codeModeModules` injects ES modules the program can import
(`import { pct } from "format.js"`). `executor.js` is reserved by the SDK.

## Discovery

The normal flow is: compact `discover.search("keyword", { limit })` →
`discover.describe(callable)` for the one schema you need → the direct call.

| Call                                                                                           | Returns                                                                                                  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `discover.search({ query, limit, offset, namespace, includeParameters, includeOutputSchema })` | `{ results, namespaces, meta }`; compact rows by default                                                 |
| `discover.describe(callable)`                                                                  | One tool's full definition plus `resultEnvelopeKeys`; current-catalog error with recovery if not exposed |
| `discover.list_namespaces({ includeTools? })`                                                  | Namespaces with counts and governance metadata; `includeTools` is for inventory only                     |

Contract (`buildCatalogProvider` in `apps/mcp/src/mcp/codemode.ts`):

- Rows omit `parameters`/`outputSchema` unless requested. Long descriptions
  are truncated with `descriptionTruncated: true`; ranking uses the full text,
  and a trailing `Paid tool:` notice always survives.
- A schema-bearing search without an explicit `limit` uses the smaller
  `SCHEMA_DISCOVERY_DEFAULT_LIMIT`.
- The result is a plain object, not a decorated array: the workerd RPC
  serializer strips expando properties from arrays. The model-facing wire form
  is deduplicated to `{ results, meta }` (`serializeCodeModeResult`).
- An unknown `namespace` throws an error naming the nearest namespaces.
- Every app-tool row carries caller-relative authorization from
  `evaluateMcpToolScopeAuthorization`, the same seam dispatch uses.
  `authorized: false` rows list `requiredScopes` and `missingScopes`.
- Rows carry `schemaFreshness` (`source`, `sourceHash`, `syncedAt`, …) and the
  response carries `meta.freshness.catalogBuiltAt`, to tell a stale D1 row from
  a stale discovery surface.
- Equivalent tedi-owned workflow tools collapse into one row with
  `equivalentTediOwners`. Call the canonical callable (`flow.run`,
  `skills.run_workflow_status`, `skills.inspect_skill_workflow_run`,
  `skills.run_workflow_history`) unless the request targets a specific tedi.
  `describe` and `list_namespaces({ includeTools: true })` stay exact.
- For an ambiguous text query in a tenant context, a model judgment may reorder
  at most twelve authorized rows of the lexical shortlist. It can only permute
  those rows; exact-name lookups, browse, and failed judgments keep lexical
  order, and `meta.discovery.order` reports which applied.
- Recorded org skills rank alongside tools (`kind: "skill"`, a `skill://` uri,
  a `load` expression). Full skill bodies are one call away via
  `resources/read`.

The unified gateways also implement the MCP skills extension
(`io.modelcontextprotocol/skills`): `skills/list`, `skills/get`, `skill://`
resources, and `resources/directory/read`. Rules are enforced by the
`apps/mcp/src/mcp/skill-*` tests. See [Skills](../cognition/skills.md).

## Outer Surface Lanes

Pinned by `apps/mcp/src/mcp/outer-surface-lanes.test.ts`:

| Lane                             | Outer tools                                                                                                           | Why                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Stateless fast path (`index.ts`) | `code`, `get_info`, authenticated `get_profile`, capability-dependent muscle companions, plus configured catalog rows | Verified caller headers control visibility; `ask` needs an org context |
| Session (`server-factory.ts`)    | `code`, `ask`, authenticated `get_profile`, plus configured catalog rows                                              | The caller is resolved and may open a Home delegation                  |

Request-scoped targeting keeps large aggregates cheap:

- A `tools/call` for a concrete D1 tool registers only that tool. Configured catalog calls retain the complete discovery projection while registering only the requested tool.
- A `code` call that names explicit providers (`home.read_home_run(...)`)
  hydrates only those namespaces; programs that call `discover.*` get the full
  catalog.
- `get_info`, `server/discover`, and `tools/list` answer from resolved app
  metadata without building the aggregate. Legacy `initialize` is rejected.
- Single-item JSON-RPC batches are accepted and answered as arrays.

## Result Bounds

`shapeBoundedCodeModeResult()` wraps upstream `truncateResult()`:

- Within budget, the result passes through unchanged. The default is 6,000
  tokens (24,000 characters of compact JSON). Override per app with
  `mcpConfig.codeModeResultMaxTokens`, or per tedi with `resultMaxTokens`.
- Over budget, the result is replaced by a detectable envelope
  `{ __tedix_truncated: true, marker, originalType, approxTokens, maxTokens, guidance, preview }`
  — never a bare clipped string. `preview` is valid compact JSON or the
  truncated string.
- The `code` result is `structuredContent: { executionId, result, resultIdentity?, logs? }`.
  `resultIdentity` (run, status, revision, skill, tedi join keys) is computed
  before truncation so an oversized result still links to workflow state.

The CLI (`packages/cli/src/code-result.ts`) unwraps the envelope and
recognizes the marker: `tedix code` prints the preview with a stderr hint, and
commands that parse rows fail loudly instead of reading a clipped page as empty.

## Prompt Budget

The `code` tool description is rebuilt on each server build, after D1 tools
load and skill enrichment runs, and is capped at
`MAX_CODEMODE_DESCRIPTION_CHARS` (32,000). Compact types carry only callable
signatures; full schemas live behind discovery. Large aggregates omit per-tool
types entirely (`compactTypesInlined=false`, normal); `descriptionTruncated=true`
means the fallback form was needed and is worth investigating.

`enrichToolsWithSkills()` must run before `registerCodeModeTools()`, because
the discovery catalog snapshots tool descriptions at build time.

## Per-Tedi Code Mode

Shared logic lives in `@tedix/tedi-codemode-core`; the Agent runtime mounts it
from `apps/tedi-runtime/src/mcp-mount.ts`.

1. All real tools register on an inner `McpServer`.
2. `registerCodeModeTools()` links an MCP `Client` over
   `InMemoryTransport.createLinkedPair()` and calls `listTools()` (10s timeout).
3. Every tool becomes `codemode.<sanitizedName>`.
4. Synthetic helpers: `codemode.__tools()` (names + one-line descriptions),
   `codemode.__doc({ name })` (full types), `codemode.__runtime()`.

If `LOADER` is missing, discovery times out, or zero tools are found, the
registrar returns `false` and the caller falls back to per-tool registration.

Computer tools get a 60s inner dispatch budget (`open_computer`,
`close_computer`, `exec`) and 30s for `read_execution`/`cancel_execution`; long
commands return an execution id instead of holding the call open.

A tedi's outbound `tedix_mcp_code` tool takes one uninvoked
`async () => …` expression. For a single known call, `tedix_mcp_call_tool` is
preferred.

### Durable Code Mode

| Lane               | Owner                                   | Use                                                           |
| ------------------ | --------------------------------------- | ------------------------------------------------------------- |
| `code`             | Request-scoped MCP wrapper              | Bounded read-only batches and disposable transforms           |
| `run_durable_code` | `AgentTediDO` + `CodemodeRuntime` facet | Programs with several calls, side effects, or approval pauses |

The facet (`codemode:tedi`, created by `createTediDurableCodemode()`) stores
code, call arguments, results, approval state, and replay progress in its
SQLite database. Generated code still runs in a disposable Worker Loader;
durability is the host replay log, not a live VM.

Connectors:

- `mcp` — `list_namespaces` and `search_tools` are replayable reads;
  `call_tool` requires approval because it can reach writes.
- `workspace` — replayable `read_file`/`diff_content`; approval-gated
  `write_file` with bounded prior content kept for rollback.

Connector globals are proxies, so `Object.keys(mcp)` is not discovery; the
`discover.*` namespace is absent in this lane. The host rejects programs that
shadow a connector in its own initializer (`const mcp = await mcp.call_tool(…)`).
Instructions are injected by `apps/tedi-runtime/src/durable-codemode-lifecycle.ts`.

Lifecycle tools: `run_durable_code`, `get_code_execution`,
`list_code_executions`, `approve_code_execution`, `reject_code_execution`,
`rollback_code_execution`, `recover_code_execution`. A tedi may start and read executions; approve,
reject, and rollback are operator-only — a tedi never approves its own side
effect. Approval binds to the exact recorded arguments, and rollback runs only
registered connector compensations; it cannot undo arbitrary MCP side effects.

When a delegated Home child pauses, the tedi emits `approval.requested`, the
parent Home run stays `requires_approval`, and resolving the approval resumes
the execution exactly once. CLI: `tedix code` is the stateless gateway path;
`tedix tedi <slug|id> code|executions|execution|approve-code|reject-code|rollback-code|recover-code`
resolve the worker within the selected organization and call the resource-bound
`tedis` API projections through that gateway. Connect credentials are never
forwarded to a different worker MCP hostname. Reads require `mcp:tedis.read`,
starting code requires `mcp:tedis.write`, and approve/reject/rollback/recover require
`mcp:tedis.admin` plus a verified human operator and live organization RBAC.
Verified machines can read and start code but cannot resolve approvals. The API
binds internal delegation provenance to the exact worker, organization,
operation, normalized arguments and a short expiry. It is trusted only on the
named service binding; it is not a public bearer grant or a one-use replay fence.
The runtime retains its native execution IDs and approval checks. Existing
direct runtime API-key operator access retains its separate authorization path.

### Interrupted execution recovery

`recover_code_execution` (gateway `recover_tedi_code_execution` in its discovered namespace) is an
explicit human management action. Supply only the execution ID. The trusted
host reads its journal revision and conditionally records an error when it is
still running, unchanged for at least 315 seconds, and has no active host pass.
Paused approvals and completed runs remain unchanged. Reads never recover runs.

Recovery preserves code, logs and call entries. Its result says completion is
unconfirmed and side effects may have occurred. Inspect those effects before
repeating any action; recovery neither replays code nor rolls back effects.
The existing native facet and journal remain authoritative across deployment.

Every model/API/history projection is bounded and redacted in
`apps/tedi-runtime/src/durable-codemode-projection.ts` (code ≤4,000 chars,
logs ≤20 entries, tool calls ≤20 entries with bounded args/results). Full
replay state stays private to the facet.

## Destructive Calls

`tedix code` has no elicitation round trip. Every destructive
(DELETE-method) tool — including proxied third-party tools — requires
`confirmDestructive: true` plus a non-empty `reason` when called statelessly
(`requireDestructiveToolApproval`, `apps/mcp/src/mcp/governance.ts`). The
gateway strips both fields before dispatch unless the tool's own schema
declares them. Omitting them fails closed with a recovery hint.

## Paid Inner Tools

Payment is enforced at the host boundary before `executeTool()`:

1. The program calls a paid tool; `codemode.ts` strips inline `_meta`,
   re-checks authorization, and calls `checkToolPayment()`.
2. Without a valid proof, the inner call returns a payment-required result,
   which the outer `code` call returns as an x402 v2 error `CallToolResult`
   (`_meta["x402/error"]`).
3. The caller retries the same outer call with `_meta["x402/payment"]` (or a
   `payment` argument, for clients that cannot set request `_meta`).
4. The outer result carries `_meta["x402/payment-response"]`.

## Telemetry

- The outer `code` call emits one `tool_call` event via the registration-time
  wrapper (`apps/mcp/src/mcp/tool-registration.ts`).
- Inner calls pass an `executionId` to `executeTool()`, which emits one
  `tool_call` per inner call; `codemode.ts` emits one `code_exec` per program.
  Standard tools never set `executionId`, so nothing double-fires.
- Structured logs: `_cm: "rpc"` (per inner call), `_cm: "exec"` (per program,
  including result size, truncation, and discovery counts), and
  `_cm: "aggregate"` (aggregate cache lifecycle).
- Durable executions emit one bounded runtime event per inner call
  (`surface: "durable_codemode_call"`).

## Aggregate Cache

Aggregate surfaces are cached in three tiers keyed by one fingerprint
(`aggregateSurfaceCacheKey`, hashed for storage keys):

| Tier | Store                  | Scope       | Hard TTL |
| ---- | ---------------------- | ----------- | -------- |
| L1   | Isolate memory         | Per isolate | 120s     |
| L2   | Workers Cache API      | Per colo    | 10 min   |
| L3   | R2 (`AGGREGATE_CACHE`) | Global      | 1h       |

A tier is fresh for 120s; between soft and hard TTL the stale surface is
served immediately while one single-flight background rebuild refreshes all
tiers. Degraded surfaces (an app failed or exceeded
`AGGREGATE_ENTRY_TIMEOUT_MS`) are never cached. Consequence: while any
aggregated app keeps failing to resolve, every request rebuilds live. When
cold rebuilds dominate, check `entry_timeout` and resolve failures before
treating it as latency.

## Security Model

| Concern              | Mitigation                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Network exfiltration | `globalOutbound: null`                                                                             |
| Secret access        | No env, secrets, or filesystem in the sandbox; tools dispatch over RPC                             |
| Resource exhaustion  | Per-app `codeModeTimeout` (5–330s, default 330s on the gateway); isolate discarded after execution |
| Auth bypass          | Outer `code` check plus per-inner-call scope re-check                                              |
| Cross-namespace      | Only explicitly wired provider functions are callable                                              |

Durable worker code retains a 300-second execution limit. Its run, approval and
rollback RPCs receive 315 seconds, leaving the enclosing gateway time to return
the terminal result. The synchronous CLI commands use a 330-second deadline;
explicit app timeout pins remain effective. Budgets are defined in
`packages/api-contract/src/schemas/tedi-durable-code.ts`. A timeout does not prove
a write failed: read the execution journal before retrying.

## Related

- [MCP runtime](runtime.md)
- [MCP Apps](apps.md)
- [Skills](../cognition/skills.md)
- [Cloudflare Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- [Cloudflare Codemode SDK](https://developers.cloudflare.com/agents/api-reference/codemode/)
- [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/)

Explicit aggregate `toolIds` and `endpointPrefixes` remain restrictions, including
on the Tedix admin app. Nested entries retain their own filters; a parent
`readOnly` restriction applies to every descendant. Selected organization context
survives recursion. `apps/mcp/src/index.ts` uses the same resolution-stack cycle
guard for explicit and implicitly added platform entries.

A `discover.describe` miss means the exact callable is absent from the current
gateway catalog. It does not establish missing membership or an upstream
credential failure. The diagnostic supplies current-catalog recovery; validate
upstream authentication separately. `flow.run` checks its recorder and selected
runner before creating a draft, and checks arguments against the mounted runner
schema. Actual execution remains subject to the runner's authorization and
workflow validation.

## Configured native catalog tools

An app can configure tools with `transport: "catalog"` and the closed
`catalog/search` or `catalog/describe` endpoint. Search accepts query, namespace,
bounded paging, and schema inclusion options; describe accepts an exact
`namespace.tool` callable. These operations use the same request-local discovery
projection as Code Mode without creating a Dynamic Worker. Discovery reports
execution authorization; it does not grant it.

Each enabled row needs its own explicit capability mapping. Missing, empty,
invalid, namespace-only or wildcard-only mappings do not expose the tool.
The compact gateway lists the base tools plus its actually configured,
caller-permitted catalog rows using the stored tool metadata and stable paging.
No configured rows means the base surface stays unchanged. Aggregate-only rows
are available after normal session construction, not through compact list
hydration. The stateless lane still omits `ask`.

Catalog operations execute synchronously in the original caller context;
async-task replay and executable code inputs are refused. Arbitrary Code Mode
programs still use a fresh anonymous isolated Dynamic Worker with no ambient
network access. Native catalog calls can still use the existing discovery API
and ranking services; no billing savings or deployment is implied by local tests.

Configured catalog rows use the shared strict search or describe input declaration.
They require capability-map mode (`enforcePolicies: false`); policy-mode rows do not expose this transport.
