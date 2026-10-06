# @tedix/mcp-shared

Shared MCP server primitives — auth, scopes, transport, and protocol helpers reused across every Tedix MCP server.

## Overview

Tedix runs multiple MCP servers (`apps/mcp` customer-facing, `apps/tedi` tedi runtime, and others). This package holds the pieces that would otherwise be duplicated across them: a stateless Web-native transport, scope/capability conventions, auth middleware, well-known metadata endpoints, task/subscription helpers, and payment (x402) types. It runs on Cloudflare Workers (`nodejs_compat` not required) and has no DB or Descope SDK dependency of its own — consumers inject their own JWT validator/extractors.

This is a **shared library**, not a Worker app. The MCP application edge lives in `apps/mcp`; the tedi runtime MCP server lives in `apps/tedi`. Both import from here.

## Features

### Stateless transport

`./transport` exposes one `mountMcp()` entry point with two stateless serving
engines. Normal requests on simple mounts use the MCP SDK v2
`createMcpHandler()` engine; their optional Tedix-authored `server/discover`
request is handled by the custom discovery path. Mounts that configure Tedix
extensions use the Web Request/Response-native
`StatelessMcpTransport` through the SDK's public `McpServer.connect()` API.
Neither engine keeps session state, an SSE event store, or a standalone
server-initiated notification stream.

```typescript
import { StatelessMcpTransport } from "@tedix/mcp-shared/transport";
```

### Server factory

`createMcpServer` preserves SDK constructor options and adds structured
input-validation tool errors.

```typescript
import { createMcpServer } from "@tedix/mcp-shared/server";

const server = createMcpServer(
	{ name: "my-app-mcp", version: "1.0.0" },
	{ instructions: "Optional server instructions" },
);
```

### Scopes and capability profiles

`./auth/scopes` owns the `mcp:<tool>` scope convention (Descope Agentic Identity Hub) plus the tedi capability-scope vocabulary referenced by `packages/auth`:

```typescript
import {
	toolToScope, // "invoice_create" -> "mcp:invoice.create"
	buildScopesSupported,
	hasScope,
	enforceScopes,
	CAPABILITY_SCOPES, // "platform:admin" | "mcp:tedis" | "mcp:apps" | ...
	CAPABILITY_PROFILES, // { standard, platform_admin }
	resolveTediScopes, // resolve a tedi's mcp_capability_profile -> scopes
	DEFAULT_TEDI_SCOPES,
	TEDI_MCP_SCOPES, // tedi:channel.read, tedi:brain.write, ...
} from "@tedix/mcp-shared/auth/scopes";
```

`platform:admin` and `mcp:settings` are excluded from `CAPABILITY_PROFILES.standard` — they are never granted to a tedi identity by default (see `NON_TEDI_CAPABILITY_SCOPES` in `src/auth/scopes.ts`).

### Auth middleware and principal

`./auth` validates incoming requests via API key (`X-API-Key: sk_...`), gateway token (internal container calls), or Bearer JWT (Descope OAuth / Tedi V2). The consumer supplies its own JWT validator/scope/tenant extractors (typically wrapping `@tedix/auth/jwt` and `@tedix/auth/types`) to avoid a hard dependency on `@tedix/auth`.

```typescript
import {
	createMcpAuthMiddleware,
	buildWwwAuthenticate,
} from "@tedix/mcp-shared/auth";
import { validateToken } from "@tedix/auth/jwt";
import { extractJwtScopes, getTenantId } from "@tedix/auth/types";

const authenticate = createMcpAuthMiddleware({
	descopeProjectId: env.DESCOPE_PROJECT_ID,
	gatewayToken: env.GATEWAY_TOKEN,
	validateJwt: validateToken,
	extractScopes: extractJwtScopes,
	extractTenantId: getTenantId,
});

const result = await authenticate(request);
if (result instanceof Response) return result; // error
// result is McpAuthContext
```

Successful auth is projected into a shared `AuthPrincipal` shape (`./auth/principal`) so MCP, tedi, API, and client code share one vocabulary for caller identity (`source`, `tediId`, `orgId`, `scopes`, ...).

### Well-known metadata

`./well-known` builds RFC 9728 OAuth Protected Resource metadata (`.well-known/oauth-protected-resource`); `./well-known/oauth` covers the authorization-server metadata side.

```typescript
import { buildProtectedResourceMetadata } from "@tedix/mcp-shared/well-known";

const metadata = buildProtectedResourceMetadata({
	resource: "https://myapp.mcp.tedix.dev/mcp",
	authorizationServers: [descopeAuthServerUrl],
	scopesSupported: ["mcp:search.listings", "profile", "email"],
});
```

### Tasks, payments, and schema normalization

- `./tasks` — MCP task-extension helpers (`clientSupportsTasks`, `McpTaskError`, `McpTaskHandlers`) for long-running tool calls.
- `./payment` — x402 payment-required types (`X402ExactPaymentRequirements`, `TedixPaymentRequiredResult`) shared by any MCP server that gates tools behind payment.
- `./schema-normalization` — normalizes the JSON-Schema subset used for MCP tool inputs into a dependency-free field map (`NormalizedToolInputSchema`) so runtime adapters can convert to Zod/TypeBox/etc.
- `./codemode` — availability check for Code Mode (`isCodeModeAvailable`, gated
  on a `LOADER` WorkerLoader binding). `@tedix/tedi-codemode-core` owns the
  execution runtime itself.
- `./protocol`, `./mcp-param-headers`, `./resources`, `./trace-context` —
  protocol constants/headers, the stateless request binder for raw relays
  (`bindModernMcpRequest`), resource registration, and observability
  trace-context propagation. MCP clients use the SDK v2 `Client`
  (`@modelcontextprotocol/client`), which owns version negotiation.

## Related

- `packages/auth` — Descope JWT validation and identity; this package's `createMcpAuthMiddleware` is typically wired with `@tedix/auth/jwt` + `@tedix/auth/types` as the JWT validator/extractors.
- `packages/ssrf-guard` — a runtime dependency used for outbound-URL protection (OAuth client-credentials token endpoints).
- [MCP app platform](../../docs/public/mcp-app-platform.md) — public context for
  the protocol surface this package implements.
- [Workers and governance](../../docs/public/workers-and-governance.md) — public
  context for the capability-scope and connected-app authorization planes.
