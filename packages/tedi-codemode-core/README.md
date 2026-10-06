# @tedix/tedi-codemode-core

Shared per-tedi MCP Code Mode wrapper: turns an inner tool surface into one stateless `code` tool.

## Overview

Every tedi serves an `/mcp` endpoint backed by an inner `McpServer` with many
tools. Rather than exposing those tools directly, the Agent runtime wraps them
in Cloudflare's Code Mode pattern: the model writes one JavaScript function
that calls tools as typed `codemode.*` methods inside a sandboxed
`DynamicWorkerExecutor`, instead of making one MCP tool call per step.

`apps/tedi-runtime/src/mcp-mount.ts` mounts this wrapper on the per-tedi MCP
surface. The MCP edge in `apps/mcp` uses shared execution helpers with its own
D1-backed providers. This package targets Cloudflare Workers with a
`WorkerLoader` binding — the
`code` tool is only registered when a `loader` is supplied; otherwise callers
fall back to standard per-tool registration. The public
[MCP app platform](../../docs/public/mcp-app-platform.md) describes the
surrounding connection surface.

## Usage

```typescript
import { registerCodeModeTools } from "@tedix/tedi-codemode-core/register-codemode-tools";

const activated = await registerCodeModeTools(outerServer, innerServer, {
	loader: env.LOADER, // WorkerLoader binding; undefined disables Code Mode
	tediId,
	traceContext: { surface: "tedi-runtime-mcp", organizationId, traceId },
	timeoutMs: 30_000,
	extras: async (outerServer, runtime) => {
		// The Agent runtime adds scratch-state providers and an execute tool
		// through this hook, sharing the executor and providers.
	},
});
```

`registerCodeModeTools` connects to `innerServer` over an in-memory transport,
discovers its tools via the MCP protocol, generates typed signatures with
`generateTypesFromJsonSchema`, and registers a single outer `code` tool that
runs model-authored JS through `DynamicWorkerExecutor`. Inside the sandbox,
each discovered tool becomes a `codemode.<toolName>()` call, plus synthetic
`codemode.__tools()`, `codemode.__doc({ name })`, and `codemode.__runtime()`
introspection functions. Computer lifecycle and execution calls use bounded
request timeouts independent of command runtime limits. Mutations are serialized
through a side-effect queue so concurrent writes in one run do not race. Use
`open_computer`, file tools and `exec`, then `read_execution` when a command
returns an execution ID; `cancel_execution` stops it and `close_computer`
releases the environment.

## Package Exports

```typescript
import { registerCodeModeTools } from "@tedix/tedi-codemode-core/register-codemode-tools";
import {
	runStatelessCodeMode,
	wrapStatelessCodeModeSource,
} from "@tedix/tedi-codemode-core/run-stateless-code";
import type {
	CodeModeExecutionContext,
	CodeModeExtras,
	CodeModeRuntime,
	CodeModeTraceContext,
	RegisterCodeModeToolsOptions,
	ToolSummary,
} from "@tedix/tedi-codemode-core/types";
```

- `runStatelessCodeMode` — runs one request-scoped execution through
  `DynamicWorkerExecutor.execute()`. The Cloudflare codemode SDK never throws
  on a sandboxed JS error; callers must check the returned `error` field
  instead of trusting `result`.

## Types

`CodeModeRuntime` is the shared executor + provider-list handle passed to
`extras` callbacks. The Agent runtime uses it to add computer scratch-state
providers and its `execute` tool, sharing the same `DynamicWorkerExecutor`
and trace logging as the base `code` tool.

## Related

- [MCP app platform](../../docs/public/mcp-app-platform.md) — public context for
  the gateway and per-tedi MCP layers.
- `@cloudflare/codemode` — upstream SDK this package wraps
  (`DynamicWorkerExecutor`, `generateTypesFromJsonSchema`, `sanitizeToolName`,
  `truncateResult`).
