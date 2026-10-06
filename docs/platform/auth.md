---
summary: "Platform identity, principals, credentials, RBAC/FGA, and auth middleware"
read_when:
  - Updating auth middleware, Descope integration, RBAC/FGA, API keys, or AIH
  - Debugging user, service, tedi, external-agent, or MCP authentication
title: "Platform auth"
---

# Platform Auth

Tedix UUIDs are the source of truth for organization, user, tedi, service, and
external-agent principals. [Descope](https://docs.descope.com) is the identity
adapter: it proves external identities and supplies Agentic Identity Hub (AIH)
OAuth, FGA, Token Vault, roles, and scopes, but a Descope subject is never Tedix
authority by itself. This doc owns platform identity and authorization; MCP-edge
discovery and per-tool enforcement are summarized in
[MCP runtime](../mcp/runtime.md).

Authorization is layered. Federation proves who authenticated, not what they may
do. Descope issues identity and policy-filtered scopes, FGA holds app/tedi
relationships, D1 holds Tedix-local capability config, and the MCP edge enforces
per-tool scopes before execution.

```text
          Descope: AIH (OAuth 2.1) · FGA · Token Vault · users · policies
                 │                       │                        │
        Tedix OS (os.*)          MCP edge (*.mcp.*)        Tedi runtime
        Descope session JWT      AIH OAuth + scopes        service binding / tedi JWT
                 └───────────────────────┼────────────────────────┘
                                   API (oRPC + OpenAPI)
```

## Principals

`principal_identities` maps an exact `(provider, issuer, subject)` tuple to one
Tedix principal of class `organization`, `user`, `tedi`, `service`, or
`external_agent`. The tuple is globally unique; rebinding fails closed and
revocation keeps the row for audit. Users are global; other classes are
organization-scoped. Validated JWT paths resolve the mapping after normalizing
the issuer. New code uses `@tedix/auth/principal-identity` and
`@tedix/db/queries/principal-identities`; do not add provider-id lookups.

Human profile ownership is deliberately asymmetric, not bidirectional sync:

| Concern                           | Owner                                                                       |
| --------------------------------- | --------------------------------------------------------------------------- |
| Canonical user                    | Tedix UUID bound in `principal_identities`                                  |
| Verified email                    | Descope; D1 projection refreshes on bootstrap or explicit sync (no webhook) |
| Display name, avatar              | D1; provider claims fill only missing values and never overwrite            |
| Password, MFA, recovery, sessions | Descope only                                                                |
| Membership presentation           | D1, following the canonical profile                                         |

### CMS platform authority

An account role and an OAuth grant are separate. Human Connect tokens may identify a platform admin without carrying roles or `platform:admin`; ordinary MCP domain `.admin` scopes do not satisfy the CMS transfer gate. Eligible humans explicitly request `tedix login --scope-profile platform-admin` and approve the separate **Platform administration** choice. Ordinary presets exclude it. Grant issuance and use verify the current top-level Descope project role; a tenant role with the same name does not qualify. CLI auth status reports credential authority, not live account eligibility.

For native tedis, MCP resolves the current capability profile and constructs `X-Tedix-Tedi-Id` and `X-Tedix-Tedi-Scopes` on its CMS service request. CMS honors platform scope only after verifying the service secret and matching the tedi actor/id. Public headers and service/kernel actors do not supply tedi authority. Existing selected-organization checks at Connect and platform cross-organization semantics remain in force.

## Credential types

| Method                         | Format                             | Org scope               | Use                                                      |
| ------------------------------ | ---------------------------------- | ----------------------- | -------------------------------------------------------- |
| User JWT                       | `Authorization: Bearer <jwt>`      | Selected tenant (`dct`) | Tedix OS and other human product sessions                |
| Service binding                | Transport trust, no token          | Delegated scope only    | Worker-to-worker                                         |
| M2M JWT                        | `Authorization: Bearer <jwt>`      | `tenants` claim         | External integrations (Descope access keys)              |
| Tedi JWT                       | `Authorization: Bearer <jwt>`      | FGA + D1 profile        | Tedi runtime → API                                       |
| OAuth 2.1 (AIH)                | `Authorization: Bearer <jwt>`      | Token claims            | MCP clients                                              |
| AIH M2M (`client_credentials`) | `Authorization: Bearer <jwt>`      | Token claims            | Tedis and external-agent sessions → MCP; no user consent |
| API key                        | `X-API-Key: sk_…` or `Bearer sk_…` | Owning organization     | Automation at the API edge; rejected on `/mcp`           |

### Boundaries

| Boundary                       | Credential                                                    | Tenant check                                       |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------------------------- |
| Human app → API                | Descope session JWT via the auth host                         | Selected `dct` + Tedix membership/FGA              |
| MCP client → MCP               | AIH OAuth JWT                                                 | Claims + tool scopes + app checks                  |
| External coding agent → MCP    | Short-lived AIH M2M JWT for a registered principal/session    | Client tags + active D1 principal/session + scopes |
| Tedi → assigned app / peer MCP | Short-lived AIH JWT from `mcpCredentials.resolve`             | Tedi lifecycle + org match + FGA assignment        |
| Tedi runtime → API             | Descope access-key JWT, `entityType: "tedi"`                  | `tediId`/`descopeUserId` claims + FGA + D1 profile |
| MCP edge → API                 | Service binding + forwarded principal + `X-Tedix-Mcp-Tool-Id` | The edge's per-tool decision                       |
| Tedix tool → vendor API        | Token Vault credential                                        | User or tenant credential scope                    |
| Worker → Worker                | Service binding                                               | Exact delegated API scope only                     |

A service binding authenticates transport, not the procedure: a bare binding
fails `withAuthorization` unless it carries an exact delegated scope or a
verified MCP tool attestation. Shared MCP service-binding principals start with
no capabilities. `PLATFORM_SERVICE_TOKEN` proves possession of a shared secret
only; it never implies `*`, `platform:admin`, or `tedi:admin`, and exists for
local/raw-HTTP paths. New paths use named service bindings.

### API keys (`sk_*`)

Per-organization keys for API automation (`packages/db/src/schema/api-keys.ts`,
`packages/db/src/queries/api-keys.ts`). `sk_test_` / `sk_live_` are labels and do
not select a data environment. Keys are stored as SHA-256 hashes and carry
scopes, an optional IP allowlist, and expiry. `API_RATE_LIMITER`
(`apps/api/src/worker-app.ts`) buckets RPC by credential-or-IP and public REST by
IP.

- `organizations.rotateApiKey` replaces the hash in place, returns the raw key
  once, keeps the old hash valid for a 24-hour grace period, and requires
  step-up.
- Keys are constrained by `createScopeMiddleware`, not RBAC. `*` satisfies
  wildcard-aware guards; `platform:admin` does not satisfy unrelated machine
  scopes.
- OS fleet-runner mutations accept only a key with the literal `os:fleet-run`
  scope (not `*`, not `platform:admin`); only a platform principal may mint it.
- On MCP, `X-API-Key` carrying a Descope access-key JWT is converted to a Bearer
  token and validated as a JWT. A bearer value starting with `sk_` is rejected
  with 401 (`apps/mcp/src/auth-helpers.ts`).

### External-agent sessions

Coding agents open an immutable Agent-Session at the MCP gateway's no-store
`POST /external-agents/session`, then receive a short-lived MCP credential.

- Identity reads use a shared D1 read-retry with a five-second deadline; a
  timed-out read is never replayed. Transient failures surface as 503
  (`session_backend_unavailable`), not invalid credentials.
- Issuance is idempotent per session, resource, and scope set, serialized by a
  D1 lease. A busy lease returns 409 `credential_issuance_in_progress`; the CLI
  retries that response up to three times. It reuses the existing Descope client
  and rotates only the access token.
- The CLI caches the session token until near expiry, bound to workspace,
  principal, session, gateway, key, and scopes. A timeout keeps the session;
  retry with it rather than creating a new identity.
- **Workload identity (experimental).** GitHub Actions may exchange its OIDC
  token instead of storing an API key. Only GitHub's issuer, `RS256`, the Tedix
  audience, an exact `repo:` subject bound to an active principal, age ≤ 10
  minutes, and a `jti` are accepted. `(issuer, jti)` is consumed atomically; the
  assertion is never stored or forwarded. The principal's
  `metadata.allowedScopes` is an upper bound, and escalation fails rather than
  being intersected. The gateway never takes the organization from the request
  body. Suspending the principal is the stop switch.
- An owner/admin may end an abandoned session with
  `retire_abandoned_external_agent_session`. It refuses active Attempts, ends the
  session, deletes its Descope MCP clients, revokes the D1 credential rows, and
  emits `external_agent.session.retired_abandoned`.

Owners: `apps/mcp/src/external-agent-session.ts`,
`packages/cli/src/external-agent.ts`, and the API's
`externalAgentIdentity.issueMcpCredential`.

### Worker ingress

`WORKER_INGRESS_POLICY` in `scripts/lint-worker-route-authz.ts` classifies every
Worker as public, app-authenticated, Cloudflare Access-protected, or
service-binding-only and pins `workers_dev` / `preview_urls`;
the gate (`--strict` in `lint:repo`) compares it with every app's
`wrangler.jsonc` or `cloudflare.config.ts`.
Route-bearing Workers need a verified guard or an inline `authz: public` reason
per route. `scripts/lint-authz.ts` flags by-id lookups that never bind the
caller's organization.

Cloudflare Access is an additional ingress layer, not product auth.
`cloudflareAccessPrincipalIdentity` (`packages/auth/src/principal-identity.ts`)
adapts the runtime-verified `ctx.access` identity (exact audience and account,
never headers), which must still resolve through `principal_identities` and
pass the usual tenant, FGA, and scope checks.

## Browser sessions

- Tedix OS (and its CLI picker), private Docs, and CMS admin share one Descope
  identity but each holds its own host-only `HttpOnly` product session.
- The token carries `sub`, the selected tenant `dct`, and that tenant's
  flattened `roles[]` and `permissions[]`.
- `apps/session-broker` on the auth host is the only refresh owner. Product
  Workers receive one-time grants over service-binding RPC and keep short-lived
  JWTs in their own cookies. `packages/auth/src/mount-session-broker.ts` is the
  single mapping from surface to cookie names, callback paths, and start
  provenance.
- A signed-out cross-site navigation is redirected to the same-origin bounce
  `GET /auth/session-broker/continue?redirect_to=…`
  (`packages/auth/src/product-session-broker.ts`), which then starts the flow.
  The bounce relays only a validated relative path. Allowing cross-site
  navigations at `start` itself was rejected: it would exempt the very request
  the check protects.
- OS browser RPC is same-origin; the Worker translates the session to Bearer
  server-side. Only explicit step-up operations create a bearer client.
- `cms-runtime` strips the product cookie and any browser `DS` before Worker
  Loader dispatch and supplies an internal `DS` cookie derived from the broker
  JWT. The CMS template verifies the JWT against Descope JWKS with an exact
  issuer and an optional exact `aud`.
- Org resolution (`apps/api/src/rpc/orpc.ts`) maps issuer + `dct` through
  `principal_identities`; slug reconstruction is forbidden.

## RBAC

Descope is the RBAC source of truth; `roles[]` and `permissions[]` arrive in the
JWT and are enforced by `withPermission()` plus UI gating.
`ROLE_PERMISSION_GRANTS` (`packages/auth/src/rbac.ts`) is the baseline that
`bun packages/auth/scripts/sync-descope-rbac.ts --apply` provisions and the fallback used when a token has no
`permissions` claim; editing it grants nothing until synced. The sync only adds,
so `controlPlane.getDescopeRbacDrift` reports only what Descope lacks. Tenant
admins compose custom roles from Tedix-defined permissions (`ALL_PERMISSIONS`)
but cannot mint permissions.

| Role               | Permission envelope                                                                 |
| ------------------ | ----------------------------------------------------------------------------------- |
| `owner`            | Admin permissions plus `billing:manage`; never platform authority                   |
| `admin`            | Org app/tedi/team/settings/content/storage/tool operations; no billing, no platform |
| `member`           | Read-only app/tedi/team/analytics                                                   |
| `viewer`           | Read-only app/tedi/analytics                                                        |
| `tedi`             | Empty; tedi authority comes from the D1 profile and FGA                             |
| `catalog-operator` | `catalog:manage` only                                                               |
| `platform-admin`   | `platform:admin`, `catalog:manage`, and the explicit `os:*` permissions             |

Rules:

- `owner`/`admin` never carry Descope `Super User` or `Impersonate`.
- `platform:admin` is not a wildcard inside `withPermission()`. Human checks
  need the exact permission or a role that explicitly grants it; machine
  credentials need the exact declared scope.
- `withAuthorization(userAuthorization, machineScope)` routes human JWTs to
  RBAC and API keys, M2M, and tedi JWTs to scope checks. The human declaration
  cannot be empty; subject-bound endpoints (org bootstrap, invitation accept,
  "my memberships") declare `{ handlerOwnedUserAuthorization: "<reason>" }` and
  enforce the relationship in the handler.
- Platform-only procedures (`tedis.updateGovernance`, `rebind`, `recover`,
  `decommission`, `purge`) apply both `createScopeMiddleware("platform:admin")`
  and `assertPlatformAdminOrServiceBinding` (`apps/api/src/rpc/routers/tedis/crud.ts`).
  `isPlatformPrincipal` (`packages/auth/src/types.ts`) accepts a user with the
  `platform-admin` role or scope, an API key or M2M token with `platform:admin`
  or `*`, or a tedi whose `context.tediScopes` include them.

## Service-to-service

- `apps/api`, `apps/mcp`, `apps/tedi`, and `apps/skill-runtime` export a named
  `InternalEntrypoint` for bindings. Their public `fetch` strips the
  service-binding marker (`stripServiceBindingMarker`), so `isServiceBinding`
  (`packages/worker-kit/src/request-auth.ts`) is false for any internet request.
  `apps/tedi-runtime` has no public ingress. Nothing is inferred from Host or IP.
- On the binding to `apps/api`, the MCP edge stamps `X-Tedix-Tedi-Id` and
  `X-Tedix-Tedi-Scopes` (resolved from `tedis.mcp_capability_profile`);
  `withAuth` hydrates `context.tediId` / `context.tediScopes` from them.
- `apps/skill-runtime` is internal-only: service binding or
  `PLATFORM_SERVICE_TOKEN`, no user JWTs, everything but `GET /health`
  authenticated.

## Tedi identity and authority

Tedis are Descope users: login `tedi:{slug}`, alias `{slug}@tedix.tech`, custom
attributes `tediId` and `entityType`. `createTediIdentity()`
(`packages/auth/src/tedi-identity.ts`) creates the user, a user-bound access key
(tenant `org_tedix`, role `tedi`, 90-day expiry), and FGA relations. Tedis can
sign into Tedix OS like humans when they hold the right roles and grants.

**Tedi runtime → API.** The runtime exchanges its access key for a JWT
(`packages/auth/src/access-key-exchange.ts`); `withTediAuth` validates it.

```json
{
	"sub": "<access-key-client-id>",
	"tediId": "<uuid>",
	"descopeUserId": "<descope-user-id>",
	"entityType": "tedi",
	"tedixRuntimeApiScopes": ["tedis:read", "tedis:write", "billing:read"],
	"tenants": { "org_tedix": {} },
	"aud": ["<project-id>"]
}
```

- `descopeUserId` is required and never inferred from `sub`.
- `tenants` carries no roles, so `isPlatformAdmin()` is never true for a tedi.
  Platform authority comes only from `tedis.mcp_capability_profile` via
  `resolveTediScopes` (`packages/mcp/src/auth/scopes.ts`): `platform_admin`
  includes `platform:admin`; `standard` gets domain `.read`/`.write`; `org_admin`
  gets admin/settings scopes without `platform:admin`. Change the profile, never
  a Descope role.
- `withAuth` never sets `context.user` for a tedi, so `user.sub`-keyed paths stay
  closed: `organizations.createOrganization` requires a human `ownerEmail` +
  `ownerUserId`, and `listOrganizations` never opens.
- The live D1 profile gates the direct tedi-JWT path; the AIH M2M path enforces
  the client's stored scopes, synced from the profile and intersected with the
  app's `toolScopes` (`apps/api/src/lib/tedi-aih-client-sync.ts`).
  `mcp.sync_scopes({appId})` re-syncs an app; existing grants need fresh consent
  to gain scopes.

**Rotation.** A daily cron rotates keys older than 60 days under a per-tedi D1
lease, stores the new encrypted `DESCOPE_ACCESS_KEY` / `DESCOPE_ACCESS_KEY_ID`,
refreshes the runtime, then deactivates the old key (deferred if refresh cannot
be confirmed; the 90-day expiry still applies). `tedis.repair_tedi` idempotently
reconciles the Descope user, alias, attributes, roles, and missing key secrets.

**Tedi → MCP resource server (AIH M2M).**

1. On assignment, `ensureTediAihClientForApp()` creates or reconciles a
   pre-registered AIH client for that exact app/server and stores its encrypted
   credentials in `tedi_secrets`.
2. On connect, `mcpCredentials.resolve` resolves the target (`*.mcp.*` app or
   `*.tedi.*` peer), checks org/tedi/Descope-user consistency, and checks FGA.
3. It exchanges the client credentials (`exchangeAihClientCredentials`) and
   returns a short-lived Bearer token, cached to 80% of its TTL.
4. App servers may use the tedi JWT after the same checks; peer tedi servers
   require AIH credentials and fail closed without them.

AIH client-credentials tokens carry the client/project `aud`; human OAuth grants
are bound to the exact MCP resource URL (RFC 8707). AIH endpoints use
`DESCOPE_AIH_BASE_URL=https://api.descope.com` because Descope custom domains do
not proxy `/v1/apps/agentic/*`.

## FGA

Descope AuthZ with `user` and `app` types and `operator` / `observer`
relations, owned by `packages/auth/src/fga.ts`. D1
`apps.metadata.mcpConfig.assignmentConfig` declares the desired default
assignments (`packages/auth/src/app-assignment-policy.ts`); FGA holds the
materialized grants.

- Mutations and batch checks use `management.fga` (`grantAppOperator`,
  `grantAppObserver`, `revokeAppAccess`, `getOperableApps`, …). Use batch checks
  for authorization gates.
- Discovery queries use `management.authz` (`queryTediRelations`,
  `queryAppRelations`) for admin tooling. They throw on failure so an outage is
  never read as "no grants".
- `descopeAih.auditDrift` flags relations whose app no longer exists in D1.

AIH scopes decide whether a caller may reach a capability; FGA decides whether
it may act on a specific Tedix object. Handlers check scopes before dispatch and
FGA or attribute checks for object arguments inside. Do not create one OAuth
resource per domain object. When a downstream provider already enforces row or
document permissions, use the acting user's vaulted credential instead of
rebuilding them in FGA.

## Token Vault

Descope Connections and Token Vault own vendor OAuth tokens, PATs, and API keys.
Credentials are keyed by Connection id (`connectionProviderId` or
`config.auth.connectionId`) and stored at user, tenant, or explicit `hybrid`
scope. MCP tools fetch them at execution time and inject only the needed
upstream headers; tool config never stores secrets. In hybrid mode, owners
default user-first and other members tenant-first, so a personal grant never
silently becomes workspace authority; `credentialPreference: "user-first"` opts
in.

## MCP and AIH

- `apps/mcp` is the resource server; Descope AIH is the authorization server
  (DCR and CIMD — see [the CIMD decision](../decisions/tedi-client-oauth-cimd.md)).
- Descope policies filter scopes at issuance; the MCP edge enforces the issued
  scopes on every call. Scopes follow `mcp:<tool.name>`.
- AIH consent policies are authored in Descope, not by Tedix code. The scope
  setup steps live in `packages/api-contract/src/schemas/mcp-capability-scopes.ts`.
- The MCP handler (`apps/mcp/src/mcp/handler.ts`) overrides any `appId` or
  `tediId` argument with the caller's context, preventing cross-app or
  cross-tedi reads.

Consent-flow rules (`packages/auth/src/aih-client.ts`,
`apps/os/src/account/inbound-consent-page.tsx`):

1. Gate consent policies on `user.tenantIds CONTAINS "<tenantId>"`. A
   roles-only condition can evaluate against empty context and silently deny;
   roles may only narrow an already tenant-scoped rule.
2. Use the `inbound-apps-user-consent` flow (`MCP_CONSENT_FLOW`) with the tenant
   already selected. Selecting several organizations produces several
   tenant-bound tokens, never one multi-tenant token.
3. The consent page (`/oauth/consent` in Tedix OS) embeds the Descope flow and
   replaces only the consent screens; authentication stays with Descope. It
   calls `selectTenant` once and waits until the session JWT's `dct` matches
   before mounting consent. On an expired refresh family (`E064006`) it explains
   that nothing was granted and replays the original authorization request.
4. CLI access tokens use a current-tenant JWT template: `dct` plus that tenant's
   roles and permissions, no multi-tenant `tenants` map.

| MCP request                               | Result                                  |
| ----------------------------------------- | --------------------------------------- |
| `X-API-Key` with a Descope access-key JWT | Converted to Bearer, validated as JWT   |
| Bearer starting with `sk_`                | 401                                     |
| Expired JWT or wrong `aud`                | 401                                     |
| Missing required scope                    | 403 `insufficient_scope`                |
| No auth on an authenticated app           | 401 + `WWW-Authenticate`                |
| Service binding                           | Internal principal with explicit scopes |

## Security properties

**Step-up.** Organization deletion, `organizations.rotateApiKey`, and
`tedis.rotateAccessKey` require a session token carrying Descope's `su: true`
claim (`requireStepUp`, `apps/api/src/rpc/step-up.ts`). The client must run the
flow and send that exact token; an ordinary refreshed token lacks the claim.
Freshness is Descope's step-up token timeout, not re-derived from `iat`.
Rotation is gated because it hands the caller a working credential that outlives
a hijacked session. `useStepUpAuth` (`apps/os/src/lib/step-up-auth.ts`) fails
closed. Only interactive user JWTs are subject to step-up; machine credentials
are gated at issuance. Site archive/deprovision and app deletion use exact-name
confirmation instead.

**Content Security Policy.** Surfaces embedding a Descope flow use the nonce CSP
from `descopeFlowContentSecurityPolicy` (`packages/auth/src/descope-csp.ts`);
the CMS studio keeps a local copy. Deliberate looseness: `static.descope.com`
and `cdn.jsdelivr.net` stay in `script-src` (later flow screens load them); no
`form-action` (SAML POST binding); `style-src 'unsafe-inline'` (Descope injects
styles); OS `img-src https:` (avatars and logos come from unknown origins).
Tedix OS runs Zod in jitless mode (`apps/os/src/lib/zod-jitless.ts`) so it never
probes `new Function`. The Cloudflare Web Analytics beacon is an explicit
per-surface extra.

**Cookies.** OS mounts one `TedixDescopeProvider` with `persistTokens={false}`
and `autoRefresh={false}`; Descope SDK cookie-domain options are never passed.
`getParentCookieDomain` (`packages/auth/src/web.ts`) is only for server-issued
cookies.

**Audit webhook.** `apps/api/src/webhooks/descope-audit.ts` verifies the
raw-body HMAC, validates batches (≤ 100 events), and persists before returning 200. Failures return 503; deterministic ids with `ON CONFLICT DO NOTHING` make
redelivery safe. Events without a resolvable organization are skipped; this is
a tenant archive, not a complete project archive. Descope treats 2xx as final.

**Agent audit.** Every MCP `tool_call`, `prompt_get`, and Code Mode `code_exec`
records `actorType` (`user`, `tedi`, `external_agent`, `m2m`, `service`,
`anonymous`), `actorId`, `tediId` / `agentTediId`, `subjectUserId`,
`oauthClientId`, `grantedScopeCount`, `delegationMode`, `skillRunId` /
`skillId`, and a trace id. This records what context was used; it is not an
authorization source.

## Middleware

| Middleware          | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `withAuth`          | Service binding / user JWT / M2M JWT / tedi JWT / API key            |
| `withServiceAuth`   | Service binding only; fails closed                                   |
| `withTediAuth`      | Service binding or tedi JWT with explicit `tediId` + `descopeUserId` |
| `withPermission(p)` | Descope permission check                                             |
| `validateAuth()`    | MCP OAuth JWT validation at the edge                                 |

`withAuth` order (`apps/api/src/rpc/orpc.ts`): service binding → external-agent
session-exchange marker (only `openSession` / `issueMcpCredential`) → forwarded
MCP user → external-agent identity → user JWT → M2M JWT → tedi JWT → API key.
The service-binding branch short-circuits first and hydrates `tediId`,
`tediScopes`, and `descopeUserId` (from `X-Tedix-Acting-User`, an identity hint,
not a grant). All routes are contract-first via `implement()`.
`validateToken()` uses the Descope SDK's `validateSession()` with built-in JWKS
caching.

## CMS (Emdash) tool calls

Emdash's MCP endpoint accepts only its own `ec_pat_*` / `ec_oat_*` tokens and
rejects JWTs and cookies. The CMS studio therefore proxies tool calls to Emdash's
REST API (`/_emdash/api/*`) with `Cookie: DS=<forwarded JWT>` and
`X-EmDash-Request: 1` over the `CMS_DISPATCH` service binding, where Emdash's
external-auth hook validates the Descope JWT. This stores no credentials and
follows the user's session. Stored PATs were rejected (unencrypted, user-bound,
no `client_credentials`), and AIH cannot front Emdash's per-tenant OAuth
servers. If Emdash delegates unknown bearer formats to external auth, this can
become a direct MCP proxy. See [CMS](../emdash/cms.md).

## Embedded provider host delegation

A provider host may pass a short-lived JWT through
`createEmbeddedProviderSession.hostDelegation`. The signed gateway session binds
it to the installation and host; the runtime carries it in private per-call MCP
metadata, never model arguments. `resolveEmbeddedHostDelegation` (service
binding only) revalidates session, installation, tedi, tenant, source app,
callable, and `mcpConfig.embeddedHostDelegation.audience` before MCP forwards it
as `X-Tedix-Host-Delegation`. The provider verifies its own JWT; Tedix never
holds the provider signing key. Code:
`apps/api/src/rpc/routers/tedis/embedded-host-delegation.ts`,
`apps/mcp/src/mcp/embedded-host-delegation.ts`,
`packages/mcp-client-core/src/client-manager.ts`.

## Key files

| File                                               | Purpose                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `packages/auth/src/principal.ts`                   | Normalized `AuthPrincipal` and internal MCP scopes          |
| `packages/auth/src/principal-identity.ts`          | Provider tuple → Tedix principal; Cloudflare Access adapter |
| `packages/auth/src/jwt.ts`                         | JWT validation (standard and AIH)                           |
| `packages/auth/src/rbac.ts`                        | Role → permission baseline                                  |
| `packages/auth/src/fga.ts`                         | FGA mutations, batch checks, AuthZ queries                  |
| `packages/auth/src/tedi-identity.ts`               | Tedi Descope user and access-key lifecycle                  |
| `packages/auth/src/aih-client.ts`                  | Pre-registered AIH clients and credential exchange          |
| `packages/auth/src/descope-fetch.ts`               | Bounded-retry fetch for Descope REST paths the SDK lacks    |
| `packages/auth/src/session-broker.ts`              | Broker allowlists, TTLs, RPC contracts, URL validators      |
| `apps/session-broker/src/index.ts`                 | Auth-host broker: authorize, product RPC, logout, refresh   |
| `packages/mcp/src/auth/scopes.ts`                  | Capability profiles and scope helpers                       |
| `apps/api/src/rpc/orpc.ts`                         | `withAuth`, `withServiceAuth`, `withTediAuth`               |
| `apps/api/src/rpc/routers/mcp-credentials.ts`      | Tedi credential resolution                                  |
| `apps/api/src/rpc/routers/tedi-app-assignments.ts` | FGA-backed assignment management                            |
| `apps/api/src/rpc/routers/descope-aih.ts`          | AIH resource reconciliation and drift audit                 |
| `apps/mcp/src/auth-helpers.ts`                     | MCP JWT validation and scope extraction                     |
| `apps/mcp/src/well-known.ts`                       | OAuth protected-resource metadata                           |
| `apps/mcp/src/mcp/handler.ts`                      | Tool execution and cross-scope override                     |

## Related

- [MCP runtime](../mcp/runtime.md)
- [Data model: organization identity](./data-model.md)
- [API layer](./api.md)
- [Tedi client OAuth / CIMD decision](../decisions/tedi-client-oauth-cimd.md)
