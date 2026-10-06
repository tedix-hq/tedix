# @tedix/mcp — MCP Server

Cloudflare Worker that serves MCP tools through a stateless, per-request
`mountMcp()` (`@tedix/mcp-shared/transport`, MCP SDK v2). Every tenant gets its
own subdomain; every request resolves its app from D1 and builds the tool set
from configuration, so adding a tool never means adding a handler file.

Architecture overview: [MCP app platform](../../docs/public/mcp-app-platform.md).
Operating rules for changes in this directory: [`AGENTS.md`](./AGENTS.md).

## What a tool is

A tool is a **D1 row**, not a TypeScript module. Each `app_tools` row names the
tool (`tool_id`, verb-first snake_case such as `list_skills`), its input schema,
the upstream it calls (REST, OpenAPI, another MCP server, or a platform
namespace), the scopes it requires, and any widget it renders. At request time
the single `ToolHandler` in `src/mcp/handler.ts` reads those rows and executes
whichever kind the row declares. To add or change a tool, change its row (via
the platform API or CLI); to change _how a kind of tool executes_, change
`ToolHandler`.

## Scope enforcement: two gates

A registered tool is guarded by exactly one of two gates, and a tool registered
after the first gate runs is unguarded unless it gets its own check:

- **Request-level edge gate** — `enforceMcpAccess()` in `src/index.ts`
  evaluates the resolved app's tools before dispatch. Required scopes come from
  the app's policy mode, its explicit `toolScopes` map, or per-tool
  `authRequired`.
- **Native dispatch gate** — `home__*` tools are merged into the tool set after
  the edge gate has run, so they are checked at dispatch by
  `enforceNativeHomeSurfaceToolScope` in `src/mcp/tool-registration.ts`.

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
