---
summary: "Code Mode execution model: Dynamic Worker Loader sandbox, namespaces, discovery, result bounds, durable executions, and inner-tool authorization"
read_when:
  - Updating MCP Code Mode, provider namespaces, compact types, or Dynamic Worker Loader behavior
  - Debugging the single code tool, sandbox execution, discovery, or inner-tool authorization
title: "MCP Code Mode"
---

# MCP Code Mode

Code Mode collapses a large MCP tool surface into one `code` tool. The model
writes an async function against namespaced providers; it runs in a Dynamic
Worker with `globalOutbound: null`, and every namespace call dispatches back to
the host over Workers RPC, where the normal tool pipeline (auth, scopes,
telemetry, timeouts, payment) runs. Tedix builds on
`DynamicWorkerExecutor.execute(code, providers)` from `@cloudflare/codemode`.

| Surface                 | Where                                               | Activation                 |
| ----------------------- | --------------------------------------------------- | -------------------------- |
| App / aggregate gateway | `apps/mcp` (`apps/mcp/src/mcp/codemode.ts`)         | `mcpConfig.codeMode: true` |
| Per-tedi MCP            | `apps/tedi-runtime` via `@tedix/tedi-codemode-core` | `LOADER` binding present   |

## Invariants

- **No network, env, secrets, or filesystem in the sandbox.** Only explicitly
  wired provider functions are callable.
- **Inner calls are re-authorized.** The outer call authorizes `code`; each
  inner call re-checks the resolved tool's scopes before `executeTool()`.
- **Call the exact callable** (`namespace.tool(args)`) returned by discovery;
  `name`/`displayName` are labels.
- **Name namespaces literally.** Hydration parses the program for literal
  `namespace.tool(...)` references; computed access (`globalThis[ns]`) never
  hydrates and fails at call time.
- **Inner failures are data.** An inner failure returns a result the program
  can inspect; only program errors fail the outer call. Any inner failure also
  adds `failures: [{ tool, error }]` (≤10 entries) to the outer result.
- **Bounded retries.** Two identical failed calls exhaust the retry budget; the
  next identical call is blocked without dispatch
  (`packages/tedi-codemode-core/src/failure-budget.ts`), on both surfaces.

## Namespaces

Config-driven, resolved in order: `mcpConfig.codeModeNamespaces[prefix]`
(semantic renames only; keep names stable across servers so tedis can reuse
what they learned), the camelCase root of the endpoint prefix
(`memoryGraph/search` → `memory`), the `{source}__{tool}` prefix, `toolTypeId`,
then `tools`. Governance metadata lives in
`@tedix/mcp-shared/namespace-governance`; built-ins win collisions and
duplicate config-derived callables are rejected. `aggregateTedis` entries
become role namespaces (`cto.*`) that keep the tedi's identity and auth.

Built-ins: `discover` (below); `flow` (`flow.run` validates against the
selected runner's schema, records a draft skill, and starts the run; it
composes `skills` and workforce namespaces rather than being a second
dispatcher); `codemode.__runtime()` for correlation ids (tedi id is
`runtime.actor?.tediId ?? runtime.tediId` across surfaces).
`mcpConfig.codeModeModules` injects importable ES modules; `executor.js` is
reserved by the SDK.

## Discovery

Flow: `discover.search(query, { limit })` → `discover.describe(callable)` → the
call. `discover.list_namespaces({ includeTools })` is for inventory.
Contract (`buildCatalogProvider`):

- Rows omit schemas unless requested; schema-bearing searches without a
  `limit` use a smaller default. Truncated descriptions keep a trailing
  `Paid tool:` notice.
- Results are plain objects, not decorated arrays: the workerd RPC serializer
  strips expando properties from arrays.
- Each row carries caller-relative authorization from
  `evaluateMcpToolScopeAuthorization`, the same seam dispatch uses
  (`requiredScopes`, `missingScopes`). Discovery reports authorization; it
  does not grant it.
- `schemaFreshness` per row and `meta.freshness.catalogBuiltAt` distinguish a
  stale D1 row from a stale discovery surface.
- Equivalent tedi-owned workflow tools collapse into one row with
  `equivalentTediOwners`; call the canonical callable unless targeting a tedi.
- For ambiguous tenant queries a model judgment may permute at most twelve
  authorized lexical results; `meta.discovery.order` says which order applied.
- Org skills rank alongside tools (`kind: "skill"`, a `skill://` uri).
- A `describe` miss means the callable is absent from this gateway's catalog,
  not that membership or upstream credentials are broken.

Tools with `transport: "catalog"` expose `catalog/search` / `catalog/describe`
through the same request-local projection without a Dynamic Worker (see
`docs/public/mcp-app-platform.md`).

## Outer Surface Lanes

Pinned by `apps/mcp/src/mcp/outer-surface-lanes.test.ts`: the stateless fast
path (`index.ts`) exposes `code`, `get_info`, `get_profile`, and configured
catalog rows but never `ask` (it needs an org context); the session lane
(`server-factory.ts`) adds `ask`. Request-scoped targeting keeps large
aggregates cheap: a concrete `tools/call` registers only that tool; a `code`
program naming explicit providers hydrates only those namespaces, while one
calling `discover.*` gets the full catalog; `get_info`, `server/discover`, and
`tools/list` answer from app metadata without building the aggregate.

## Result Bounds and Prompt Budget

`shapeBoundedCodeModeResult()` passes results through up to 6,000 tokens
(override: `mcpConfig.codeModeResultMaxTokens`, per tedi `resultMaxTokens`).
Over budget it returns a detectable envelope
`{ __tedix_truncated: true, marker, approxTokens, maxTokens, guidance, preview, … }`,
never a bare clipped string. `resultIdentity` is computed before truncation so
an oversized result still links to workflow state. The CLI
(`packages/cli/src/code-result.ts`) recognizes the marker so row-parsing
commands fail loudly instead of reading a clipped page as empty.

The `code` description is rebuilt per server build and capped at
`MAX_CODEMODE_DESCRIPTION_CHARS` (32,000). Large aggregates omit per-tool types
(`compactTypesInlined=false` is normal; `descriptionTruncated=true` is worth
investigating). `enrichToolsWithSkills()` must run before
`registerCodeModeTools()` because discovery snapshots descriptions at build
time.

## Per-Tedi Code Mode

`registerCodeModeTools()` links an MCP `Client` to the inner `McpServer` over
an in-memory transport, lists tools (10 s timeout), and exposes each as
`codemode.<name>` plus `__tools()`, `__doc({ name })`, and `__runtime()`. A
missing `LOADER`, a discovery timeout, or zero tools makes it return `false`
and the caller registers tools individually. Computer tools get a 60 s inner
budget (30 s for `read_execution`/`cancel_execution`); long commands return an
execution id instead of holding the call.

### Durable Code Mode

`code` is for bounded reads and disposable transforms. `run_durable_code` runs
on a `CodemodeRuntime` facet of `AgentTediDO` (`createTediDurableCodemode()`)
that stores code, arguments, results, approval state, and replay progress in
SQLite. Generated code still runs in a disposable Worker Loader; durability is
the host replay log, not a live VM.

- Connectors: `mcp` (`list_namespaces`/`search_tools` replayable;
  `call_tool` approval-gated) and `workspace` (`read_file`/`diff_content`
  replayable; `write_file` approval-gated with prior content kept for
  rollback). Connector globals are proxies, so `Object.keys(mcp)` is not
  discovery; programs that shadow a connector are rejected.
- A tedi may start and read executions; approve, reject, rollback, and recover
  are operator-only (`mcp:tedis.admin`, a verified human, live RBAC). A tedi
  never approves its own side effect. Approval binds to the exact recorded
  arguments; rollback runs only registered connector compensations.
- A paused delegated Home child keeps the parent `requires_approval`; resolving
  the approval resumes the execution exactly once.
- `recover_code_execution` marks a run as errored only if it is still running,
  unchanged for ≥315 s, and has no active host pass. It neither replays nor
  rolls back: inspect side effects before repeating anything.
- Model/API projections are bounded and redacted
  (`apps/tedi-runtime/src/durable-codemode-projection.ts`).
- Execution limit is 300 s; run/approval/rollback RPCs get 315 s and the CLI
  330 s (`packages/api-contract/src/schemas/tedi-durable-code.ts`). A timeout
  does not prove a write failed: read the journal before retrying.

## Destructive and Paid Calls

`tedix code` has no elicitation round trip, so every destructive tool,
including proxied third-party ones, needs `confirmDestructive: true` and a
non-empty `reason` when called statelessly (`requireDestructiveToolApproval`,
`apps/mcp/src/mcp/governance.ts`). The gateway strips both unless the tool's
schema declares them.

Payment is enforced at the host before `executeTool()`: without proof the
outer `code` call returns an x402 v2 error (`_meta["x402/error"]`); the caller
retries the same outer call with `_meta["x402/payment"]` (or a `payment`
argument) and receives `_meta["x402/payment-response"]`.

## Telemetry

The outer `code` call emits one `tool_call`; inner calls pass an `executionId`
so each emits its own `tool_call`, and `codemode.ts` emits one `code_exec` per
program. Structured logs use `_cm: "rpc" | "exec" | "aggregate"`.

## Aggregate Cache

Aggregate surfaces are cached under one fingerprint (`aggregateSurfaceCacheKey`):

| Tier | Store                  | Hard TTL |
| ---- | ---------------------- | -------- |
| L1   | Isolate memory         | 120 s    |
| L2   | Workers Cache API      | 10 min   |
| L3   | R2 (`AGGREGATE_CACHE`) | 1 h      |

Entries are fresh for 120 s, then served stale while one single-flight rebuild
refreshes all tiers. Degraded surfaces (an app failed or exceeded
`AGGREGATE_ENTRY_TIMEOUT_MS`) are never cached, so while any aggregated app
keeps failing every request rebuilds live. When cold rebuilds dominate, check
`entry_timeout` and resolve failures before treating it as latency.

Per-app `codeModeTimeout` is 5–330 s (default 330 s on the gateway).
