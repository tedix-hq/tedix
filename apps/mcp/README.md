# @tedix/mcp — MCP Server

Connect AI assistants to your Tedix organization's tasks, project knowledge,
apps, decisions, and results through MCP. Tedix is a platform for agents,
apps, and work.

Cloudflare Worker that serves MCP tools through a stateless, per-request
`mountMcp()` (`@tedix/mcp-shared/transport`, MCP SDK v2). Every tenant gets its
own subdomain; every request resolves its app from D1 and builds the tool set
from configuration, so adding a tool never means adding a handler file.

Architecture overview: [MCP app platform](../../docs/public/mcp-app-platform.md).
Operating rules for changes in this directory: [`AGENTS.md`](./AGENTS.md).

## Responsibility and test map

| Responsibility                                                 | Owner                         | Coverage                                                                                                                                               |
| -------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host routing, request access and protocol handling             | `src/index.ts`                | `index.test.ts`, `base-domain-routing.test.ts`, `connect-organization.test.ts`, `subscriptions.test.ts`                                                |
| Aggregate resolution, caches and connection defaults           | `src/aggregate-surface.ts`    | `aggregate-batch-resolution.test.ts`, `aggregate-cache-purge.test.ts`, `aggregate-host-connection-defaults.test.ts`, `aggregate-join-deadline.test.ts` |
| Namespace targeting and aggregate filtering                    | `src/codemode-targeting.ts`   | `scope-extraction.test.ts`                                                                                                                             |
| Tool-list projection, pagination and task/approval envelopes   | `src/mcp-result-transform.ts` | `mcp/outer-surface-lanes.test.ts`, `mcp/tools-list-pagination.test.ts`, `mcp-result-transform.test.ts`                                                 |
| Provider wiring, discovery and flow composition                | `src/mcp/codemode.ts`         | `mcp/codemode-catalog.test.ts`, `mcp/codemode-flow.test.ts`                                                                                            |
| Code execution, authorization, payments and read receipts      | `src/mcp/codemode.ts`         | `mcp/codemode-telemetry.test.ts`, `mcp/codemode-auth.test.ts`, `mcp/codemode-payment-input.test.ts`, `mcp/codemode-isolation.workerd.test.ts`          |
| UI catalog, layout inference, health sweeps and transient HTML | `src/mcp/codemode-ui.ts`      | `mcp/codemode-ui.test.ts`                                                                                                                              |

`bun run test:memory` checks cold Code Mode construction in an isolated Worker
with a 128 MB V8 old-space budget, 5,791 retained fictional schemas and 20,422
compact tools. It denies outbound traffic and releases the Worker on exit.

The gateway runs bounded stateless programs; the persistent turn loop belongs
in `apps/tedi-runtime`. Browser and memory operations are configured provider
tools dispatched through `src/mcp/tool-execution.ts` and `src/mcp/handler.ts`.
The handler owns dispatch and internal RPC/REST calls. External REST, upstream
MCP and stored JavaScript execute in `handler-external-transport.ts`,
`handler-mcp-transport.ts` and `handler-code-transport.ts` beside it; credential
resolution stays in `handler-connection-credentials.ts`.
Destructive approvals remain in `src/mcp/governance.ts` and payment policy in
`src/mcp/payments.ts`; these extractions do not change those boundaries.

## What a tool is

A tool is a **D1 row**, not a TypeScript module. Each `app_tools` row names the
tool (`tool_id`, verb-first snake_case such as `list_skills`), its input schema,
the upstream it calls (REST, OpenAPI, another MCP server, or a platform
namespace), the scopes it requires, and any widget it renders. At request time
the single `ToolHandler` in `src/mcp/handler.ts` reads those rows and executes
whichever kind the row declares. To add or change a tool, change its row (via
the platform API or CLI); to change _how a kind of tool executes_, change
`ToolHandler`.

## Signed-out personal agent Sessions

A public MCP app listed in its organization's `metadata.personalAgentProtocol.mcpUrl`
verifies `Poppy-Version` and `Poppy-Session` before handling MCP requests without
account credentials. The API service checks the stored organization and app,
verifies the client's delegation and Session signature, then creates or continues
the Session in D1. Session identity grants no account permissions. Authenticated
apps retain their existing access requirements.

The organization settings accept `allowedClientIds`, `blockedClientIds`, and
`requestsPerMinute` (default 60). Counters are shared across Sessions and Worker
isolates. Client metadata and JWKS fetches use the SSRF guard with no redirects,
a five-second timeout per document and a 64 KiB body limit. The API Worker also
requires `global_fetch_strictly_public` to enforce the network boundary.

Session JWTs and fetched documents are never logged or stored. The internal
`sessionToken` field is covered by RPC development-log redaction. Verification
failures contain only protocol error codes. Sessions store pseudonymous IDs,
the declared version and ended state; delegated keys may change between requests.
New Sessions emit an app-scoped lifecycle audit event with static metadata.
Continuations, rate counters and rejected JWTs do not add governance audit rows.

Replay decision: this signed-out entry does not store JWT `jti` values. The
protocol permits accepting a replay within the 60-second freshness window;
request method, URL and any independently verified access token remain bound.
Tool authorization and operation idempotency remain separate requirements.

To publish tasks, set `metadata.personalAgentProtocol.interfaces` on the
organization to `{ excludedTasks: [], feedback: true }`. Exclusions are stored
in that organization's metadata; each has a `task` and optional
`alternative.instructions`. Discovery then advertises `GET /mcp/poppy/tasks`
on the configured public MCP host. It verifies the request's Session and returns
`excluded_tasks`, the existing app's allowlisted `skill_index`, and the feedback
endpoint when enabled. Skills use HTTPS URLs with digests of the served Markdown.
Only `mcpConfig.publicSkillSlugs` publishes skills; private, draft, archived,+tedi-owned and other-app skills remain excluded.

`POST /mcp/poppy/feedback` requires a verified Session and accepts `task` (at most
200 characters) and `description` (at most 2,000). It returns 202 with no body
after the shared agent-review intake persists the report. The intake must be
configured in the installation; redaction, per-organization throttling,
deduplication and the daily cap apply. Protocol reports carry their organization
but no invented repository SHA, fit score or user attribution. Invalid reports
return `invalid_request`; unavailable intake returns 503.

To offer a signed-out Company Agent, configure
`metadata.personalAgentProtocol.companyAgent` with an organization-owned `tediId`,
a public `description`, and `publicInstructions`. Discovery lists the Poppy
conversation endpoint under `agent.protocols`. Only those public instructions
and the visitor's conversation reach the model; internal memory and tools are
unavailable. The configured tedi must use the Agent runtime. Keep its identity
stable while conversations are retained: protocol state lives in its runtime.

The endpoint supports new messages, events with `cursor` and capped `wait`,
handoff, handoff cancel, close, and linked Direct Conversations. Requests are
deduplicated by client and User ID across Sessions and conversations. Events and
request receipts are retained with the tedi's durable state; no event expiry or
SSE streaming is offered. A Company Agent does not initiate Direct Conversations;
the personal agent starts them with a first message and `parent_conversation_id`.

Optional `companyAgent.handoff: { userId, projectId }` routes a visitor's request
to a person through the existing OS inbox. Both targets must belong to the
organization. The card explicitly says the reply will be shared with the
personal agent. Polling reconciles the person's answer into the conversation;
only a recorded response from that person is labelled human. Further visitor
messages create reply cards. Cancel or close withdraws open cards on the next
protocol request. Without a configured recipient, the agent explains that no
person is available. This does not grant account access.

Deploy the API, MCP edge and tedi runtime through the installation's release
procedure before enabling Company Agent discovery. No new shared D1 migration
is needed for its runtime-local SQLite state.

For staging acceptance, generate a validator identity with the company kit's
`keygen`, host its public metadata and JWKS, and configure that staging
organization's client policy. Run the foundation milestone with `--probe-session`
against the advertised tasks endpoint, then run `check --milestone interfaces`.
Check issuerless MCP by hand: a valid Session can initialize and list/call only
the app's public tools, while absent, invalid and ended Sessions are rejected.
Never install validator test identities in a production allowlist.

## Scope enforcement: two gates

A registered tool is guarded by exactly one of two gates, and a tool registered
after the first gate runs is unguarded unless it gets its own check:

- **Request-level edge gate** — `enforceMcpAccess()` in `src/mcp-access.ts`
  evaluates the resolved app's tools before dispatch. Required scopes come from
  the app's policy mode, its explicit `toolScopes` map, or per-tool
  `authRequired`.
- **Native dispatch gate** — `home__*` tools are merged into the tool set after
  the edge gate has run, so they are checked at dispatch by
  `enforceNativeToolScopeGate` in `src/mcp/tool-registration-policy.ts`.

Never add a tool without deciding which gate owns it.

## Develop and test

```bash
bun run dev                        # http://localhost:3000, local state only
bun run --cwd apps/mcp test:run    # Node unit tests + the workerd project
bun run --cwd apps/mcp test:workerd # workerd project + sandboxed real-API run
```

From a public checkout, `bun run dev` runs against isolated local state: no
shared database, no remote bindings, no secret provider. Anything that needs a
live tenant is out of scope for the local loop.

`vitest.config.ts` has two projects. `node` runs the unit tests; `workerd`
runs every `*.workerd.test.ts` inside local workerd, so `test:run`, `test:ci`,
and the pre-push `vp test related` query all reach it. The workerd project boots
the actual MCP Worker with a fixture API Worker and checks the public discovery
response to a transient 503. It also proxies `transport: "mcp"` tool calls
through `ToolHandler` to a 2025-era SDK v1 server and a 2026 `mountMcp` server
served on Miniflare's `outboundService`, so the call leaves through workerd's
native global `fetch`, which rejects a foreign `this` ("Illegal invocation") in
a way no Node test can reproduce.

The opt-in `test:workerd` script runs that project, then starts the actual MCP
and API Workers against a temporary local D1 database seeded with one app. The
public OpenAI app discovery request must traverse MCP's API service binding and
return that app's challenge token. A second request lists a D1-configured tool through the real
MCP `tools/list` handler and checks its input schema. A public `tools/call`
request confirms that the API refuses the unscoped read. A third local Worker
then calls that same tool through MCP's internal service binding with a synthetic
scoped tedi identity; the returned app and tool come from the real API and
temporary D1. These checks require macOS `sandbox-exec` so all Worker process
trees are limited to loopback. `dev-local.ts` removes remote bindings and
production configuration. The temporary database is deleted after the run.
