# MCP Conformance Harness

Official-MCP-conformance test harness for the Tedix stateless MCP transport
(`src/transport.ts::mountMcp`). It mounts a fixture `McpServer` (built with
`src/server.ts::createMcpServer`) behind `mountMcp()` on a local Bun HTTP
server and runs the official `@modelcontextprotocol/conformance` CLI
(0.2.0-alpha.10, 2026-07-28 scenario suite + the
`io.modelcontextprotocol/tasks` extension scenarios) against it.

## Run

```sh
cd packages/mcp
bun run test:conformance        # = bun conformance/run.ts
```

`run.ts` starts `serve.ts` on `PORT` (default 3921), runs the full
`--suite all --spec-version 2026-07-28` pass plus every executable `tasks-*`
extension scenario (the spec-version filter excludes `[extension]` scenarios), applies
`--expected-failures conformance/baseline.yml`, kills the server, and exits
with the CLI's exit code. Pass `--verbose` for raw JSON check output. To poke
the fixture manually: `PORT=3921 bun conformance/serve.ts`.

Upstream marks `tasks-status-notifications` as a zero-assertion skip, so it is
excluded rather than counted as green; `apps/mcp/src/subscriptions.test.ts`
covers that behavior.

## Baseline policy

`baseline.yml` lists scenarios expected to fail, each with a comment explaining
why. An entry is allowed only for a documented transport nonconformance (fix it
in `src/transport.ts`, then remove the entry) or for conformance-CLI version
skew against the current spec revision. The CLI fails on stale entries
(baselined scenarios that pass), so the baseline cannot rot silently.

## Fixture notes

- MRTR (Multi Round-Trip Requests) uses the SDK's native 2026-07-28 path:
  handlers return `inputRequired()` and read `ctx.mcpReq.inputResponses` /
  `requestState()`; `createRequestStateCodec` HMAC-signs `requestState`.
  `mountMcp()` marks each per-request server instance as 2026-07-28 when the
  caller sends the modern `MCP-Protocol-Version` header. The SDK keeps the
  negotiated version in a private per-instance field, so this suite fails if an
  SDK bump renames it.
- The SEP-2663 task tools drive an in-memory task store wired into
  `mountMcp({ taskHandlers })`; `-32021` capability gates wrap the SDK's
  `tools/call` handler directly (handler throws become `isError` results).

## Wire contract

`src/transport.test.ts` pins these transport rules:

- A missing `_meta` envelope field is `-32602` Invalid Params; a present but
  different `_meta` protocol version is `-32020` HeaderMismatch.
- `initialize`, like every other removed 2025 method, returns `-32601` with
  HTTP 404.
- An unsupported `MCP-Protocol-Version` rejection echoes the request id.
- `Mcp-Param-*` headers (SEP-2243) are cross-checked against the `tools/call`
  body; invalid Base64, a missing header for a bound value, or a mismatch is
  `-32020` with HTTP 400 (`validateInboundMcpParamHeaders` in
  `src/mcp-param-headers.ts`; `toolSchemaLookup` defaults to the mounted
  server's `toolInputSchemaJson`).
- On extension-rich mounts a related notification promotes that one POST to
  SSE, streams progress frames, and closes with the final JSON-RPC response.
  The exchange stays per-request and stateless: no session, sticky routing,
  standalone SSE, replay store, or Durable Object.
