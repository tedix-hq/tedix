# @tedix/ssrf-guard

Shared SSRF (Server-Side Request Forgery) protection utility for validating outbound URLs.

## Overview

Single source of truth for host/IP validation across the platform. It blocks
requests to private networks, loopback/link-local addresses, and internal
Tedix services before an outbound fetch is made. `validateUrl` is pure URL
validation; `guardedFetch` performs network I/O with `fetch` and `Headers`,
revalidates redirects, and strips credentials on cross-origin redirects.

It is imported directly by:

- **`apps/api`** (browser router, catalog source administration, connection
  policy resolution) and **`apps/docs`** (`src/source.ts`) — caller-chosen
  URLs before any outbound use.
- **`apps/mcp`** (`src/auth-helpers.ts` and `src/mcp/handler.ts`) — validates
  client metadata URLs, external tool URLs, and OAuth redirects.
- **`packages/mcp`** (`src/auth/client-credentials.ts`) — validates
  client-credentials token endpoints before fetching.
- **`apps/tedi-workstation-egress-broker`** and
  **`apps/tedi-workstation-runtime`** (`src/egress.ts`) — default-deny egress
  interception for workstation sandbox network calls.

## Usage

```typescript
import { validateUrl } from "@tedix/ssrf-guard";

const error = validateUrl("https://example.com/webhook");
if (error) {
	// error is a human-readable string, e.g. "Cannot connect to private networks"
	throw new Error(error);
}

// Dev-only escape hatch for tunneled internal services:
validateUrl("https://service.internal", { allowInternalHosts: true });
```

`validateUrl(rawUrl, options?)` returns `null` if the URL is safe, or an error
string if it should be blocked.

## What it blocks

- Non-HTTPS protocols (unless `allowHttp: true`)
- Exact internal hostnames (`api.tedix.dev`, `mcp.tedix.dev`, `localhost`, etc.)
  and internal domain suffixes (`.tedix.dev`, `.tedi.club`, `.tedix.tech`,
  `.local`, and `.internal`)
- Private/reserved IPv4 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `127.0.0.0/8`, `169.254.0.0/16`, `100.64.0.0/10` (CGNAT), `0.0.0.0`
- The same ranges expressed as decimal, hex, or octal IP literals
  (e.g. `2130706433` or `0x7f000001` → `127.0.0.1`)
- Private/reserved IPv6 (loopback `::1`, unspecified `::`, unique-local
  `fc00::/7`, link-local `fe80::/10`, and IPv4-mapped forms)

There are no installation-specific hostname exemptions in the default guard.
Trusted callers must opt into their required host class explicitly; permissions
on one surface do not become default trust on another. Private/loopback IP
checks still run unconditionally for literal addresses.
URL validation does not resolve DNS; Workers must retain
`global_fetch_strictly_public` to block private destinations after resolution.

## Options

```typescript
interface ValidateUrlOptions {
	allowHttp?: boolean; // allow http:// (dev only)
	allowInternalHosts?: boolean; // allow tedix-owned hosts (dev only, never in prod)
	allowTedixHosts?: boolean; // allow tedix-owned hosts only; localhost/.local/.internal stay blocked
}
```

`allowTedixHosts` is the lane for platform code whose caller may legitimately
name a Tedix-served origin (a tenant's `{slug}.mcp.tedix.dev` MCP endpoint, a
`{slug}.cms.tedix.dev` site to render) but must never reach the Worker's own
host or network. Used by `apps/api` (browser tools, catalog/connection MCP
endpoints). `apps/docs` uses the default (strict) mode for repository URLs.

```typescript

```
