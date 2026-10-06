# @tedix/mcp-client-core

Runtime-neutral Tedix MCP client capabilities — discovery, credentials, Code Mode, and result handling shared across tedi runtimes.

## Overview

Every tedi runtime needs to connect to its assigned MCP servers, keep tool
lists in sync, resolve per-server credentials, and turn MCP tool results into
model-ready output. This package holds that logic once so runtime packages
only decide how to expose it to their own model/tool loop. The Agent runtime
(`apps/tedi-runtime`) owns MCP connections via
`@modelcontextprotocol/client`'s `StreamableHTTPClientTransport`. It has no
model-SDK dependency of its own; model seams (JSON generation for
elicitation, tool execution) are injected by the caller. Runs on Cloudflare
Workers. The API also imports the direct `tool-liveness` module for kernel
call classification.

## Features

- **`McpClientManager`** (`./client-manager`) — connects to assigned MCP
  servers over Streamable HTTP, keeps tools/prompts/resources/guidance in
  sync, drives the MCP Tasks extension (`notifications/tasks` push on managed
  Tedix endpoints with `tasks/get` polling as the reconnect/unsupported
  fallback) and the MRTR (Multi Round-Trip Requests)
  `input_required → tasks/update` round-trip, and mirrors
  schema-level `x-mcp-header` annotations into `Mcp-Param-*` request headers.
  Stateless `server/discover` negotiation is keyed by URL plus resolved header
  identity; protocol, completions, and extension metadata expire together
  after 60 seconds, while transient negative verdicts retry after 5 seconds.
  `isAuthRecoveryError` classifies errors that should trigger a credential
  re-fetch and retry.
- **`TedixMcpRuntime`** (`./runtime`) — the higher-level per-turn runtime a
  tedi runtime instantiates: resolves credentials (with connect-timeout,
  retry-with-backoff, and last-known-good fallback), truncates/bounds tool
  results and ledger payloads (`truncatePayload`), and emits a bounded
  `resultIdentity` projection beside oversized structured results so durable
  run/status/slug/revision links survive even when the full JSON must be
  clipped. It also enforces per-tool timeout policy.
- **`createAgentElicitationResolver` / `deterministicElicitationAnswer`**
  (`./elicitation-resolver`) — when a called tool returns `input_required`,
  answers the elicitation by reasoning over the `requestedSchema` via an
  injected model seam, or deterministically (schema defaults / required-field
  zero-values) when no model is wired, so a tedi never deadlocks waiting on a
  human who isn't there.
- **Guidance resources** — concise skill, guide, and policy summaries include
  the exact server and URI for the registered `mcp_read_resource` tool. Full
  instructions are read on demand; resource templates support progressive disclosure.
- **`./types`** — shared MCP client shapes: `McpServerConfig`,
  `McpConnection`, `McpToolInfo`, `McpPromptInfo`, `McpResourceInfo`,
  `McpResourceTemplateInfo`, `McpGuidanceInfo`.

## Usage

Import from direct module entry points; the package has no root entry point.

```typescript
import { TedixMcpRuntime } from "@tedix/mcp-client-core/runtime";

const runtime = new TedixMcpRuntime({
	platform, // TedixMcpRuntimePlatform: runtime-supplied credential/discovery hooks
});
```

## Related

- `apps/tedi-runtime/src/mcp-client-runtime.ts` wires this package into the
  Agent runtime's model/tool loop.
- [MCP app platform](../../docs/public/mcp-app-platform.md) — public context
  for the Tasks and client connection surfaces.
- `packages/mcp` (`@tedix/mcp-shared`) — protocol constants, schema normalization, and
  trace-context helpers this package builds on.
