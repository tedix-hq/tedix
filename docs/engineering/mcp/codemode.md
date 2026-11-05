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
- **Inner tool failures reject.** A failed `await namespace.tool(args)` throws
  an `Error`; catch it and read `error.code` and `error.status` for first-party
  oRPC failures (for example, `NOT_FOUND` and `404`). An uncaught failure fails
  the outer call. When the program catches the error and returns, failure
  receipts add `failures: [{ tool, error }]` (≤10 entries) to the outer result.
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
`discover.describe(callable)` returns the full input schema, description and
annotations, a bounded TypeScript `resultType`, and `outputSchemaProvenance`
when a schema exists. Unknown or deeply nested parts render as `unknown`.
Request the output schema only when needed with
`discover.describe({ callable, includeOutputSchema: true })`.
The native `catalog/describe` transport retains its full descriptor
for existing clients; the CLI explicitly fetches output schemas through
`catalog/search` with `includeOutputSchema: true` for result validation.

The 6am tool test samples successful MCP results before truncation, using the
same result unwrapping as Code Mode. Installed catalog tool rows without a
declared output schema receive a shape with `x-tedix-provenance: "inferred"`.
Later samples merge shapes and make missing fields optional. These schemas are
advisory: they never validate responses or become normative `tools/list` output
schemas. Sensitive rows are excluded before inference, declared schemas win,
and catalog refreshes preserve inferred shapes until upstream declares one.
No sample values are stored in the inferred schema. The nightly catalog quality
score deducts points for missing output schemas and records their tool names in
`scores.missingOutputSchemaTools`.

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
  A skill can name the tools it uses in its SKILL.md frontmatter, for
  example `tools: [google_gmail, work.create_work_item]`: a namespace
  selects all of its tools, `namespace.tool` selects one. The skill row then
  carries `tools` (compact rows with authorization, at most twelve, the rest
  counted in `toolsOmitted`) and `unresolvedTools` for refs this gateway does
  not mount. Skill listings read the key before the summary cuts `content`
  (`readSkillToolRefs`); storage and approval are unchanged. The list is a
  pointer for search and grants nothing.
- `discover.list_namespaces({ includeSkillCoverage: true })` adds
  `skillCoverage: { coveredTools, uncoveredTools }` per namespace, naming the
  tools no organization skill lists.
- A `describe` miss means the callable is absent from this gateway's catalog,
  not that membership or upstream credentials are broken.

The built-in `search_native_tools` / `get_native_tool_schema` pair
(`apps/mcp/src/mcp/native-catalog-tools.ts`) exposes `catalog/search` /
`catalog/describe` through the same request-local projection without a Dynamic
Worker (see `docs/public/mcp-app-platform.md`).

## Outer Surface Lanes

Pinned by `apps/mcp/src/mcp/outer-surface-lanes.test.ts`: a Code Mode app
lists `code` as its only top-level tool by default. The stateless fast path
(`index.ts`) adds the built-in native catalog pair but never `ask` (it needs an org
context); the session lane (`server-factory.ts`) adds `ask`. Any other tool is
listed only when its exact registered name is in `mcpConfig.codeModeNativeTools`
(`code-mode-native-tools.ts`); this applies to the bootstrap `get_info` and
`get_profile`, the skill helpers `list_skills` and `read_skill`, and widget
tools. Unlisted bootstrap tools still answer `tools/call` for existing clients
(the CLI calls `get_info`), and every tool stays reachable as a Code Mode
callable through `discover.search`. Request-scoped targeting keeps large
aggregates cheap: a concrete `tools/call` registers only that tool; a `code`
program naming explicit providers hydrates only those namespaces, while one
calling `discover.*` gets the full catalog; `get_info`, `server/discover`, and
`tools/list` answer from app metadata without building the aggregate.

The gateway advertises `_meta["com.tedix/structuredCall"]: { version: 1 }`
on `code` in both SDK and compact listings. Clients may send
`{ invocation: { callable: "namespace.tool", args: {} } }` instead of `code`;
exactly one execution form is required. The server runs a uniquely configured
RPC read with effective `readOnlyHint: true` and no destructive hint through
its existing provider without a sandbox. Other structured calls select the
existing sandbox before dispatch, using a generated single-call program.
Both paths retain the same caller checks, approvals, execution receipts and
result bounds. Authored JavaScript always uses a fresh isolated Worker.

Widget tools such as Decisions and Activity are Code Mode callables by default: a `code`
program that calls `<namespace>.show_deck()` returns the view's `ui://`
resource in the result metadata, and hosts that render result views show it.
A host that only mounts views declared in `tools/list` needs an explicit
opt-in: list the exact widget tool names in `codeModeNativeTools`. Then clients
declaring MCP Apps (`io.modelcontextprotocol/ui`, or the older
`io.modelcontextprotocol/apps` alias) also see those enabled `config.nativeDirect`
widget tools with their native `ui://` resource links. Their `tools/list`
hydrates the aggregate, including Connect's verified selected organizations
when no single organization header is supplied; callers without Apps support
retain the compact surface. Aggregate names are organization-qualified, so an
opt-in on a multi-organization gateway lists one tool per named organization.
Modern clients declare capabilities in request `_meta`; legacy clients declare
them in `initialize` and echo the returned `Mcp-Session-Id` on later exchanges.
That stateless identifier carries only the UI declaration, never authentication
or tool authority. An explicit modern capability declaration takes precedence.
`prefersBorder` retains the layout resource's existing value.

MCP-App resources leave `ui.domain` unset so each host chooses its sandbox
origin. The widget asset origin remains in CSP; it must not be used as the
host-specific sandbox domain. Legacy Apps SDK domain metadata is separate.

An installation may configure `mcpConfig.sidebarApp` with a title and tabs
(`id`, `label`, `tool`), and opt `get_info` into
`codeModeNativeTools`. The existing bootstrap tool then advertises one global
ChatGPT entrypoint, accepts `{}`, and returns view references plus the
request's verified organization choices. Its resource is
`ui://widgets/mcp-app/{slug}/r/sidebar-app.html`. The resource contains no
member data. Code Mode becomes callable by the app as well as the model;
its inner scope, tenant and effect checks still apply on every invocation.

The sidebar discovers each exact authorized tool in the chosen organization,
then calls the returned callable through Code Mode. It renders the existing layout returned by that tool, clears old data on organization or account changes, and
reloads on tab switches or Refresh. For Tedix Work, configure `show_deck` and
`show_feed`; their layouts come from the same current tool configuration as
the conversation views, and card actions retain their authorization.
Verify the entrypoint in the actual ChatGPT host after deployment and plugin
discovery refresh. A local render or MCP descriptor does not prove that the
host displayed the sidebar entry.

## Response Field Selection

Pass `_fields: string[]` in a tool's arguments to return only the response
paths you need. For example, after describing the callable and checking its
response shape:

```js
return await work.list_work_items({
	_fields: ["data.id", "data.title"],
});
```

Paths use dots for nested properties. `data.id` selects `id` in every item
of a `data` array, retaining array order and nesting. Selecting a parent keeps
its whole value. Missing paths are omitted; an empty array returns `{}`.
Paths must have non-empty segments and cannot contain prototype keys
(`__proto__`, `constructor`, `prototype`). Invalid selectors fail before dispatch.

The gateway advertises this reserved argument in `discover.describe` and native
input schemas and Code Mode stubs, without changing stored D1 tool schemas.
It strips `_fields` before upstream dispatch. Selection runs after configured
response shaping and full output validation, before the 6,000-token cap and
before result-handle storage in R2. Error results and transport metadata remain
available. An omitted `_fields` preserves the normal response.

The `tool_call` Analytics Engine event records UTF-8 JSON byte counts as
`responseBytesBefore` (`double6`) and `responseBytesAfter` (`double7`) for
selected responses; existing input/output size slots retain their meaning.

## Result Bounds and Prompt Budget

`shapeBoundedCodeModeResult()` passes results through up to 6,000 tokens
(override: `mcpConfig.codeModeResultMaxTokens`, per tedi `resultMaxTokens`).
On the MCP gateway an over-budget result is kept whole
(`apps/mcp/src/mcp/codemode-result-store.ts`: the `AGGREGATE_CACHE` R2 bucket,
keyed by organization and `executionId`, 30-minute expiry, readable only by
the principal that produced it) and the model receives
`{ __tedix_result_handle: true, handle, preview, keys, total, expiresAt, guidance }`.
`discover.read_result({ handle, path?, offset?, limit? })` pages it back:
`path` selects a nested value, `offset`/`limit` page its compact JSON text,
and a page is capped at the same budget. When the result cannot be stored (no
bucket, no caller identity, write failure) or on durable tedi runtimes, the
detectable envelope
`{ __tedix_truncated: true, marker, approxTokens, maxTokens, guidance, preview, … }`
is returned instead, never a bare clipped string. `resultIdentity` is computed
before either bound so an oversized result still links to workflow state. The
CLI (`packages/cli/src/code-result.ts`) pages handles back in full through
`resolveCodeResult()` and recognizes the truncation marker so row-parsing
commands fail loudly instead of reading a clipped page as empty.

The `code` description is rebuilt per server build by
`buildCodeModeDescription()` (`codemode-guidance.ts`) and capped at
`MAX_CODEMODE_DESCRIPTION_CHARS` (4,000), below the 4,096 characters Claude
Code shows for an upfront tool description. It keeps only the call shape, the
`discover.search` → `discover.describe` → call loop, the approval rule and the
result envelope; per-tool types are inlined only when they fit
(`compactTypesInlined=false` is normal for aggregates). Evidence, long work
(`flow.*`), visuals (`ui.*`) and payment guidance live in the server
instructions (`codeModeInstructionParts()`, capped at 4,096 with platform text
first) and the `tedix-session-guide` plugin skill. `codemode-guidance.test.ts`
fails if either budget is exceeded. `enrichToolsWithSkills()` must run before
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

### Discovery shards

Connect's multi-organization root is never snapshotted; it is recomposed from
each selected organization's graph, about 25 MB of snapshots in total. When a
request builds an organization mount from a cacheable graph, it also writes a
compact shard of that mount's rows to `AGGREGATE_CACHE` under
`aggregate-discovery/v1/`, keyed by the mount entry and activation epoch
(`apps/mcp/src/aggregate-discovery-shards.ts`). Shard rows keep names,
descriptions, annotations, config and scopes, and drop input and output
schemas, templates and icons.

A `code` program whose only unbounded step is a namespace-free
`discover.search` (constant keys; values may vary) or `discover.list_namespaces`
reads those shards instead of the organization graphs. Organizations whose
namespaces the program calls or describes by literal name are still hydrated
in full. The shard path is skipped, and the full catalog loads, when a shard is
missing or older than one hour, when the search asks for parameters or output
schemas, when the program uses `flow`, `globalThis`, `eval` or an opaque
argument, or when the shards hold no more than `CATALOG_SCHEMA_SEARCH_MAX_ROWS`
rows (so ranking never differs: above that size it never reads schemas).
Shard rows carry `config._discoveryShard` and `ToolHandler.execute` refuses
them. A schema sync rolls the epoch, so the next full load compiles new shards;
`purgeAggregateSurfaceCaches` deletes them. Parsed shards are shared in an
isolate for 120 s (`discoveryShardCache`, 64 entries).

Per-app `codeModeTimeout` is 5–330 s (default 330 s on the gateway).
