---
summary: "Catalog-bound client OAuth for tedi connections to external MCP servers: catalog allowlist, issuer pinning, CIMD first, RFC 9207 iss validation"
read_when:
  - Adding or changing how a tedi connects to an external MCP server
  - Implementing CIMD, protected-resource-metadata discovery, or authorization-response iss validation
  - Deciding whether a tedi may connect to an MCP endpoint that is not in the catalog
title: "Catalog-bound tedi client OAuth (CIMD + RFC 9207)"
status: accepted
date: 2026-07-25
---

# ADR: Catalog-bound tedi client OAuth (CIMD + RFC 9207)

**Status:** Accepted. The catalog gate, issuer pinning, the RFC 9207 validator,
the hosted CIMD document, registration-mode selection, the API callback with
encrypted PKCE state, token exchange and tenant-vault storage are implemented.
Moving existing providers from DCR to CIMD is ongoing.

Scope: how a tedi's connection to an external (non-Tedix) MCP server is
authorized — allowlisting, OAuth client registration, authorization-response
validation and token storage. Tedix-internal app and peer-tedi auth (Descope
AIH M2M client credentials) is out of scope.

## Context

`packages/mcp-client-core` is a token consumer. The runtime asks the platform
for pre-resolved headers through `TedixMcpRuntimePlatform.resolveCredentials`
(`packages/mcp-client-core/src/runtime.ts`); no OAuth flow runs in the client.
`ResolvedMcpCredentials.connectionRequired` carries a connect URL when a grant
is missing. The tedi runtime implements the platform by calling `apps/api`
`/rpc/mcpCredentials/resolve` (`apps/tedi-runtime/src/mcp-client-runtime.ts`,
`apps/api/src/rpc/routers/mcp-credentials.ts`).

External-provider credentials use Descope Outbound Applications and the Token
Vault (`packages/auth/src/connections.ts`). `discoverMcpConnectionProvider`
already performs RFC 9728 protected-resource discovery followed by RFC 8414
authorization-server metadata with the §3.3 issuer check.

`app_catalog` (`packages/db/src/schema/catalog.ts`) holds one global row per
MCP endpoint, keyed by normalized endpoint and hash, with declared auth types.
Supplier claims on a row are provenance, not proof of endpoint ownership.

The MCP 2026-07-28 authorization specification requires RFC 9728
protected-resource discovery, CIMD over DCR (DCR is a deprecated fallback, and
credentials are keyed by issuer), and RFC 9207 `iss` validation before any
token request.

Policy: tedis may connect only to MCP servers listed in the catalog. The
catalog is the allowlist. This ADR specifies the flow inside that policy.

## Decision

### 1. The catalog is the connection allowlist

A tedi- or agent-initiated connection must resolve to an `app_catalog` row by
normalized endpoint (not display name) before any discovery or OAuth traffic.
No row means refuse, fail closed, and emit a catalog-request event. The
allowlist grows only through admin-gated catalog procedures.

### 2. The connect flow

For a catalog app that declares `OAUTH`:

1. **Catalog gate** — resolve the endpoint to its row, or refuse.
2. **Discovery** — RFC 9728 then RFC 8414 with the issuer check. Pin the
   validated issuer; later discovery that yields a different issuer refuses and
   flags drift instead of re-provisioning.
3. **Client registration, in spec order** — CIMD when the authorization server
   advertises `client_id_metadata_document_supported`: Tedix identifies itself
   with one platform-hosted metadata document whose `redirect_uris` point at the
   `apps/api` callback (`apps/api/src/oauth-client-metadata.ts`). CIMD
   identifies the software client (Tedix); the granting organization is carried
   by consent and token storage. Otherwise fall back to the Descope outbound-app
   path with DCR, keyed per issuer.
4. **Authorization code** — PKCE, RFC 8707 `resource` bound to the canonical
   server URI, expected issuer stored with the PKCE verifier, and RFC 9207
   validation (`packages/auth/src/oauth-iss.ts`) before the code reaches a token
   endpoint.
5. **Consent** — an organization operator authorizes the catalog app once for
   the organization. Tedis inherit the tenant-scoped grant through their
   connection grant and per-tool action level; they never run their own consent.
6. **Token storage** — the existing Token Vault, keyed by outbound app and
   tenant. D1 keeps binding metadata, never the secret.

### 3. Ownership

- **`apps/api` and `packages/auth` own the flow**: catalog gate, discovery,
  issuer pinning, registration-mode selection, callback, token exchange, `iss`
  validation, vault storage and audit events.
- **`packages/mcp-client-core` stays a token consumer.** At most it gains a
  typed refusal reason (`catalog_refused`) next to `connectionRequired`, so the
  runtime can explain a blocked connection instead of retrying.

## Threat model

- **Rogue or look-alike server** — not in the catalog, so refused before any
  request. A typosquatted URL matches no endpoint hash. Issuer pinning stops a
  swapped server from redirecting the flow to another authorization server.
- **Mix-up attacks** — RFC 9207 comparison, the RFC 8414 §3.3 check, `resource`
  binding and per-issuer credential isolation.
- **Consent integrity** — one operator grant per catalog app, tenant-scoped. A
  tedi cannot mint, widen or export a grant, and raw tokens never reach the tedi
  runtime; the client consumes short-lived headers.
- **Audit** — catalog refusals, issuer drift, consent grants and token exchanges
  are control-plane events attributable to an organization, an operator, and
  (for refusals) the requesting tedi.

## Consequences

- DCR is deprecated, not removed. `classifyMcpClientRegistrationMethod`
  (`packages/auth/src/oauth-client-registration.ts`) classifies inbound
  sessions as `pre_registered`, `cimd` or `dcr` so retirement can be decided
  from real usage.
- Where CIMD covers a catalog app, manual outbound-app provisioning becomes
  unnecessary; manual bindings remain for API-key apps and servers without CIMD.

## Rejected alternatives

- **Arbitrary-domain connections for tedis** — rejected by the catalog policy.
- **OAuth flow inside the client or tedi runtime** — would put tokens and
  consent logic in the agent's process; the control plane keeps both.
- **Per-organization client metadata documents** — deferred. One platform-wide
  identity means the upstream consent screen names Tedix, not the tenant.

## References

- [Platform auth](../docs/engineering/platform/auth.md)
- MCP 2026-07-28 authorization:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- MCP deprecated features:
  <https://modelcontextprotocol.io/specification/2026-07-28/deprecated>
- RFC 9207: <https://datatracker.ietf.org/doc/rfc9207/>
- OAuth Client ID Metadata Document draft:
  <https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00>
