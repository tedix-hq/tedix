---
summary: "oRPC/OpenAPI architecture: contract-first rules, RPC vs public REST boundary, lazy routers, client package, and key internal surfaces"
read_when:
  - Changing API contracts, routers, OpenAPI generation, or extraction config
  - Checking internal RPC versus public REST behavior
  - Investigating API request latency or cold isolates
title: "API platform"
---

# API Architecture

`apps/api` serves one contract tree two ways: typed oRPC at `POST /rpc/*` for
Tedix clients, Workers, and MCP, and a curated REST/OpenAPI surface at `/v1/*`
for external developers. Contracts in `packages/api-contract` are the source of
truth; routers implement them.

## Source Of Truth

| Concern                            | File                                          |
| ---------------------------------- | --------------------------------------------- |
| Complete contract tree             | `packages/api-contract/src/contracts/api.ts`  |
| Per-domain contracts               | `packages/api-contract/src/contracts/*.ts`    |
| Shared schemas                     | `packages/api-contract/src/schemas/*.ts`      |
| Router aggregation (lazy)          | `apps/api/src/rpc/routers/index.ts`           |
| Handler mounting                   | `apps/api/src/worker-app.ts`                  |
| Thin Worker entrypoint             | `apps/api/src/index.ts` (dynamic import only) |
| Public REST inventory              | `apps/api/src/rpc/public-rest-operations.ts`  |
| REST/OpenAPI filter                | `apps/api/src/rpc/openapi-filter.ts`          |
| Middleware, `skipOutputValidation` | `apps/api/src/rpc/orpc.ts`                    |
| Client package                     | `packages/api-client/`                        |

## Contract-First Rules

- Contracts are pure: schemas and routing metadata only — no runtime logic, DB
  access, or env bindings. Never define a contract inline in a router.
- Every procedure defines both `.input(...)` and `.output(...)`.
- Use `JsonValueSchema` (`@tedix/api-contract/schemas/common`) for JSON-like
  data, not `z.unknown()`/`z.any()`. Use `.passthrough()` only where extra keys
  are expected. Keep D1 JSON column types aligned with contract schemas.
- Implement with `implement(contract).$context<BaseContext>()` and build with
  `os.router(...)`; assembling routers without the implementer bypasses
  contract enforcement.
- Import by direct path, never a barrel:
  `@tedix/api-contract/contracts/api`, `@tedix/api-contract/contracts/apps`,
  `@tedix/api-contract/schemas/app`. Do not export server routers to clients.
- Procedure names are camelCase. MCP tool ids are verb-first snake_case
  (below); kebab-case procedure names are rejected by
  `scripts/mcp/sync-tool-schemas.ts`.
- Typed errors come from the `base` builder's `.errors()` (`NOT_FOUND`,
  `UNAUTHORIZED`, …); handlers throw `errors.NOT_FOUND()`, clients check with
  `isDefinedError(error)` from `@orpc/client`.
- `skipOutputValidation()` disables runtime output parsing on read procedures
  only; keep output validation on writes.

Handler plugins (`apps/api/src/worker-app.ts`): `RequestLimitHandlerPlugin`
(10 MB) and `RethrowHandlerPlugin` (non-oRPC errors reach Hono `onError`). Do
not add `CompressionPlugin` (the CDN compresses) or `SimpleCsrfProtectionPlugin`
(JSON RPC calls already force a CORS preflight).

### Adding a router

1. Define the contract in `packages/api-contract/src/contracts/<entity>.ts`.
2. Implement in `apps/api/src/rpc/routers/<entity>.ts`. Split independent
   capabilities into `routers/<entity>/<capability>.ts` with a composition-only
   root file and `shared-*` modules for reusable policy.
3. Register it in `apps/api/src/rpc/routers/index.ts` with `lazyRouter()`.
4. For a customer-facing REST operation, add the `REST` metadata tag and an
   entry in `PUBLIC_REST_OPERATION_LIST` with a justification.

## Lazy Routers

Every namespace in `routers/index.ts` is wrapped in `lazyRouter()` (oRPC's
`Lazy` with a plain `import()` loader). A request touches one namespace, and
evaluating every other namespace's contracts and schemas dominated cold-request
CPU. The matcher unlazies only the branch a request routes into;
`/openapi.json` still walks the full tree.

- Do not use `os.lazy()`: it rebuilds each procedure through `augmentRouter`
  and drops the hidden router contract that contract-first matching needs.
- `apiRouter` values are `Lazy` at runtime — never read a procedure off it;
  import the router module instead.
- `lazy-namespace-isolation.test.ts` proves every endpoint still resolves, and
  `apps/api/scripts/check-lazy-imports.ts` rejects eager router imports from
  the entrypoints.
- Cold-path dependencies (Descope JWT validation SDK, kernel submission
  recovery) stay behind dynamic imports.

## RPC vs Public REST

RPC (`POST /rpc/{router}/{procedure}`, oRPC v2 RPCLink codec) is used by
Tedix OS, the CLI, Worker service bindings, and MCP. Consumers use
`@tedix/api-client` rather than constructing wire envelopes.

REST (`/v1/*`) is **opt-in per operation**. A procedure is published only if it
carries the `REST` metadata tag and appears in
`apps/api/src/rpc/public-rest-operations.ts`; a generated-spec test proves the
two views match. `internal` is an additional deny tag. The same predicate
controls both the `/v1/*` handler and `/openapi.json`, so presence in
`apiRouter` or `apiContract` does not publish an endpoint.

The public REST surface is the customer control plane:

- Apps: CRUD, tools and adapters, catalog browse and tenant installs,
  templates.
- Tenants: organization and membership lifecycle, billing self-service,
  scoped usage/cost reads, audit reads.
- Digital workers: tedi identity/status CRUD and app assignments.

Everything else — credentials and secrets, runtime logs/sessions/devices,
Work Items, connections, payments, kernel/memory execution, browser execution,
policy internals, catalog operations, jobs — is RPC/MCP-only.

REST verbs follow HTTP semantics: `GET` for safe reads with query-suitable
input, `PUT` to replace a known resource, `PATCH` for partial updates.
Query-shaped operations stay `POST` when input is large, sensitive, or deeply
structured, or when the call creates billing, audit, workflow, or credential
state. Removed REST routes are not kept as aliases.

**Non-guarantee:** an RPC procedure, contract route, or admin MCP tool is not
necessarily available over REST.

### OpenAPI

- Spec: `{base}/openapi.json`; Scalar reference: `{base}/docs`
  (`https://api.tedix.dev` in production, `http://localhost:8787` locally).
- Responses advertise the spec with `rel="service-desc"` and the reference
  with `rel="service-doc"`; `GET {base}/` returns the same links as JSON. The
  configured `API_URL`, not the request host, owns these links.

## Authentication

Authentication and authorization are procedure-specific: read the
implementation's `withAuth`, RBAC, scope, organization, and custom guards —
never infer them from router membership or spec publication. For most
automation use an org-scoped API key (`X-API-Key: sk_...`). See
[Auth](auth.md) for the method list.

Platform-admin routers (`waitlist`, `tenantMembership`) gate on
`isPlatformPrincipal` and deliberately skip organization access checks.
`remove_tenant_membership` is destructive: it removes the Descope tenant
membership and deletes the D1 `organization_members` row, and Code Mode callers
must pass `confirmDestructive: true` and a `reason` (see
[Code Mode](../mcp/codemode.md)).

## API Client

`@tedix/api-client` owns link construction, serialization, response decoding,
retry policy, and internal caller headers.

| Adapter                     | Header                          | Use                                 |
| --------------------------- | ------------------------------- | ----------------------------------- |
| `withBearerToken(getToken)` | `Authorization: Bearer <token>` | Users on servers or trusted clients |
| `withApiKey(apiKey)`        | `X-API-Key: sk_...`             | CLI, automation                     |

Worker-to-API calls use `getInternalApiClient(env)` over the `API_SERVICE`
service binding; it sets `X-Service-Binding` and optional `X-Tedix-*` identity
headers and returns a contract-typed client. Runtime-selected procedures use
`callRpc(path, input, options)`, which preserves HTTP status and detail via
`RpcCallError`.

`RetryLinkPlugin` defaults to zero retries: every RPC is a POST and may be a
write, so callers opt in per call only for reads or idempotency-keyed
operations.

## Key Surfaces

### Tedi lifecycle

`DELETE /v1/tedis/{tediId}` **retires** a worker; it does not destroy it.
Every tedi-scoped table cascades on delete, so removing the row would erase the
customer-owned cognitive state. Retirement instead (`retireTedi` in
`packages/db/src/queries/tedis.ts`):

- purges the Descope identity, FGA grants, and MCP server registration;
- stamps `retired_at` and parks the runtime (`status="paused"`,
  `runtime_state="archived"`);
- moves the slug to `retired_slug` and renames `slug` to
  `<slug>-retired-<tediId>`, freeing the name;
- pins `isolate_agent_id` to the old slug so the Durable Object name is stable.

The update is conditional on `retired_at IS NULL`, so a concurrent retire is a
`CONFLICT`. Retired workers leave all live reads and are listed only via
`GET /v1/tedis?includeRetired=true`. Step-up re-authentication is required.

`POST /v1/tedis/{tediId}/decommission` (platform admin only) is the staged
teardown. By default it is reversible (pause, archive, stop runtime schedules).
`hardPurge=true` with an exact `confirmSlug` is the **only** path that destroys
cognitive state: it deletes the row and cascaded children, the identity, and
the supplemental memory profile, and returns `residualManualSteps` for storage
without a programmatic delete path.

### Usage and cost

`GET /tedis/{tediId}/usage`, `/tedis/{tediId}/call-costs`,
`/organizations/{organizationId}/usage`, `/cost-drilldown`, and
`/billing-ledger` accept `period` (`24h`, `7d`, `30d`) and require `tedis:read`
or `billing:read`. The same reads are exposed as the read-only `usage.*` Code
Mode namespace.

### App configuration

- **Tools:** `GET|POST /v1/apps/{appId}/tools`,
  `GET|PATCH|DELETE /v1/apps/{appId}/tools/{toolId}`,
  `PUT /v1/apps/{appId}/tools/order`. Scopes `tools:read`/`tools:write`.
- **Adapters:** `GET|POST /v1/apps/{appId}/adapters`,
  `GET|PATCH|DELETE /v1/apps/{appId}/adapters/{adapterId}`,
  `POST /v1/apps/{appId}/adapters/preflight`. Types are `AdapterTypeSchema`
  (`packages/api-contract/src/schemas/adapters.ts`). Scopes
  `adapters:read`/`adapters:write`.
- **CSP:** app-level `mcpConfig.widgetCSP` plus per-tool
  `app_tool_csp_domains`, loaded with the app's tools. Types: `connect`,
  `resource`, `frame`, `redirect`.

`toolTypeId` on `app_tools` is a plain string (`rpc`, `memory`, `search`,
`content`, `adapter`, …) that selects the MCP handler class; there is no lookup
table.

### MCP runtime lookups

Internal RPC used by `apps/mcp` to load an app and its tools:
`apps.getByDomain`, `apps.getBySlugWithTools`, `apps.getBySlugsWithTools`
(≤50 slugs, positionally parallel results), `apps.getByIdWithTools`. Response
shapes are `AppWithToolsSchema`/`AppToolSchema` in
`packages/api-contract/src/schemas/app.ts`. Runtime listing search uses
`listings.search`, `listings.adapters` (enabled adapters only), and
`listings.markets`.

### Tool schema sync

`toolSchemaSync.preview` / `toolSchemaSync.run` regenerate oRPC-backed
`app_tools` rows from contracts (`apps/api/src/services/tool-schema-sync.ts`).

- Input schemas are MCP root-object schemas. Non-object results are wrapped as
  `{ data: value }` in both `outputSchema` and `structuredContent`.
- `mode: "schema"` refreshes existing rows and prunes rows whose endpoint no
  longer resolves. `mode: "projection"` previews or upserts full rows,
  including annotations and schema provenance; `toolIdOverrides`,
  `kindOverrides`, and `widgetOverrides` pin names and widgets.
- Writes run through `ToolSchemaSyncWorkflow`. MCP validates results against
  the D1 rows, not the Worker bundle, so the rows must be reconciled after an
  API release.
- `tenantBehavioralEvals` is excluded from projection entirely.

Generated tool ids are verb-first snake_case, with the router slotted by role:

1. Bare verb: router becomes the object — `skills/list` → `list_skills`.
2. Preposition: router before it — `skills/listByApp` → `list_skills_by_app`.
3. Procedure already names its object: router dropped —
   `tedis/rotateAccessKey` → `rotate_access_key`.
4. Router word already present: unchanged —
   `memoryGraph/searchMemoryGraph` → `search_memory_graph`.
5. Cross-router collision: router after the verb — `workflows/getStatus` →
   `get_workflows_status`.

The router is never a trailing suffix. `regenerateToolIds: true` renames
existing rows; `toolIdOverrides` wins.

### OpenAPI tool import

`tenantCatalog.previewOpenApiImport` returns a generated tool plan without
writes; `catalog.runOpenApiImport` queues `OpenApiSyncWorkflow`, the only write
path for generated REST tools. It writes one `external` `app_tools` row per
operation with schemas, annotations, auth config, and provenance, and persists
`metadata.mcpConfig.openApiSync` so refreshes replay the same source.

- Provider-backed imports set `connectionProviderId`; credential headers are
  then removed from tool input schemas so the model never supplies secrets.
- `x-tedix-injected-arguments` declares MCP-only arguments (trusted runtime
  context) that are consumed before the external request is built. It is not a
  substitute for upstream authorization; collisions with real parameters are
  rejected.
- Multipart bodies become file inputs (data URL, base64, or
  `{content, filename, mimeType}`); binary responses return
  `{ filename, mimeType, base64encoded: true, content }`.
- `widgetDefaults`/`widgetOverrides` configure generated json-render tables;
  provider-specific UI lives in sync config, not widget source.
- `includePathPrefixes`/`excludePathPrefixes`/`stripPathPrefixes` handle
  multi-family specs.

Catalog operator routes (sync, scan, repair, import, provenance backfill,
`catalog.checkIntegrity`) require a service binding, an API key or M2M token
with `catalog:manage`, or a platform-admin user. Tenant callers with
`apps:update` and `catalog:manage` may import into their own non-proxy OpenAPI
base app.

### Catalog

Catalog browse is REST but authenticated (`withAuth` in
`apps/api/src/rpc/routers/catalog/policy-quality.ts`). The published set is
whatever carries the `REST` tag in
`packages/api-contract/src/contracts/catalog.ts`, for example
`GET /v1/catalog/apps`, `GET /v1/catalog/apps/{slug}`, and
`GET /v1/catalog/health-summary`. Apps are deduplicated by MCP endpoint.
`McpScanWorkflow` (`apps/api/src/workflows/mcp-scan-workflow.ts`) runs daily to
refresh server info, tools, and health scores.

### Skill workflows

Call `workflows.listDefinitions` first: it lists static platform and dynamic
skill definitions with their run/status/history tools.
`workflows.listDefinitionHealth` adds binding probes and the latest run state
(missing history is `unknown`, not degraded).

Executable skills run on `apps/skill-runtime` (`SKILL_RUNTIME` binding) via the
`skills` router:

| Procedure                                                                    | Behavior                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `runWorkflow`                                                                | Start a run; optional `runId`/`idempotencyKey` make admission retry-safe            |
| `runWorkflowStatus`                                                          | Persisted run plus live engine lifecycle (not a step timeline)                      |
| `runWorkflowHistory`                                                         | Recent runs for a tedi, skill, or org (`limit` 1–200)                               |
| `inspectWorkflowRun`                                                         | Run, revision, artifacts, steps, tool calls, cost summary (bounded reads)           |
| `listWorkflowSteps` / `listWorkflowToolCalls`                                | Paginated step and MCP call records (`limit`/`offset`, `nextOffset`)                |
| `listWorkflowRevisions` / `getWorkflowRevision` / `compareWorkflowRevisions` | Revisions observed on executed runs (not a full edit log)                           |
| `getWorkflowReliability`                                                     | Status, duration, retry, rollback, and failed-step aggregates over a bounded sample |
| `pauseWorkflow` / `resumeWorkflow`                                           | Native lifecycle calls fenced by `expectedExecutionEpoch`                           |
| `restartWorkflow`                                                            | Exactly-once restart keyed by a 1–128 char `restartId`                              |
| `approveWorkflow` / `rejectWorkflow`                                         | Standard approval events                                                            |
| `runWorkflowCancel`                                                          | Record cancellation, then terminate; `rollback: true` runs rollback handlers first  |
| `runWorkflowSendEvent`                                                       | Deliver a typed event matching `step.waitForEvent`                                  |
| `listRunArtifacts` / `getRunArtifact`                                        | Raw run artifacts                                                                   |
| `revokeSkillRun`                                                             | Revoke a confirmed-terminal run and delete its artifacts                            |

Cloudflare Workflows owns execution state; Tedix owns the pinned source,
capabilities, identity, and the `skill_runs`/`skill_run_artifacts` records.
Terminal projection is epoch-fenced, and run reads carry the current
`ENVIRONMENT` because local and production share D1 but not Workflow bindings.
Active or ambiguous runs cannot be revoked. Run, cancel, restart, approve,
reject, and send-event accept `confirmDestructive` and `reason` for stateless
MCP callers. `callSkillRuntime()` maps runtime 4xx responses to matching oRPC
errors and preserves the runtime's error code.

Workforce MCP ids for these procedures are curated in
`apps/mcp/src/mcp/aggregate-tedis.ts`; `revoke_skill_run` is not part of that
projection. See [Skills](../cognition/skills.md).

### Work Items

`workItemsContract` (`packages/api-contract/src/contracts/work-items.ts`,
prefix `/v1/work-items`) is the provider-neutral coordination object; external
trackers are projections. Tables live in `packages/db/src/schema/work-items.ts`.
MCP write tools (`create_work_item`, `update_work_item`, `cancel_work_item`,
`bulk_cancel_work_items`) live in the org-scoped Home namespace
(`apps/mcp/src/mcp/home-surface.ts`); the bulk tool is destructive and
admin-gated. See [Work Items](../cognition/work-items.md).

### Control plane

Runtime profiles, policy packs, and workspace template sets are immutable
revision families on internal `controlPlane.*` RPC
(`packages/api-contract/src/contracts/control-plane.ts`). Publish and update
append a successor with compare-and-swap; delete appends an archived
successor; rollback copies an older body to a new head and moves one tedi's
pin. Historical revisions are never mutated. Not part of `/v1/*`.

## Trace Context

Inbound calls resolve a trace id in order: W3C `traceparent` → MCP
`params._meta.traceparent` → `X-Trace-Id` → new UUID
(`@tedix/mcp-shared/trace-context`). API episode joins use the non-generating
parser so records attach to an existing episode. `tedi_runtime_events` and
`kernel_runtime_events` carry an indexed `trace_id` for cross-lane joins.

## Request Latency

A warm authenticated request is almost entirely I/O wait: serial D1 round trips
from `withAuth` (principal, organization, and membership lookups) before the
handler's own read. CPU per warm request is small, and cold isolates add a
modest first-request cost but are not the tail. To reduce latency, remove or
shorten round trips (batch or cache the auth-context lookups); rewriting a
handler's query rarely helps. The per-request D1 session uses
`first-primary` (`apps/api/src/rpc/context.ts`); handlers should read through
`context.db` so they stay inside that session's consistency guarantee.

## Extraction Configuration

`packages/api-contract/src/schemas/extraction-config.ts` owns the stored
`extractionConfig` fields on app metadata and templates. The Firecrawl item
extraction workflow is retired; the import workflow still reads
`extractionConfig.fieldMappings`. Unsupported options are rejected on write, read, and
template application — never silently stripped. Template application
substitutes `{siteContext}` and validates the merged result before writing.
No runtime consumes the other extraction fields (agent, prompt, schema,
quality and stop conditions) any more.

## Known Issue: Middleware Type Inference

The `ApiRouter` type can lose inference through complex middleware chains
(`$meta`/`$context`), yielding `UseQueryOptions<{}>`. Product clients avoid it
by typing against the pure contract. Runtime behavior is unaffected.

## Related

- [Auth](auth.md)
- [Data model](data-model.md)
- [DB access](db.md)
- [`apps/api/README.md`](../../apps/api/README.md)
- [`packages/db/README.md`](../../packages/db/README.md)
