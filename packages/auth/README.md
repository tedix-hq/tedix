# @tedix/auth

Descope authentication utilities for JWT validation across the Tedix platform.

## Overview

Provides edge-compatible authentication utilities built on `@descope/node-sdk` for JWT validation. Runs on all Cloudflare Workers with `nodejs_compat`.

## Features

- **JWT validation** — Access token verification via Descope SDK's `validateSession()` (JWKS, signature, issuer/audience handled internally)
- **Browser/session helpers** — cookie parsing, unverified JWT hints, and broker-side Descope refresh/select operations
- **Tedi identity** — tedi Descope user + access-key lifecycle (`tedi-identity`), access-key→JWT exchange (`access-key-exchange`), first-class V2 claims (`principal`)
- **Canonical principal adapters** — normalized external issuer/subject tuples for users, tenants, services, tedis, and external agents (`principal-identity`)
- **FGA / ReBAC** — relationship-based authorization: mutations, batch-checks, AuthZ queries (`fga`, `rbac`)
- **AIH clients** — AIH MCP server/client CRUD and M2M exchange (`aih-client`); exact shared resource audiences and ownership tags (`aih-audiences`); scope-manifest generation for Descope sync (`scope-sync`)
- **Connections** — Token Vault credential fetch (`connections`) and the provider registry: credential profiles, token templates, hybrid-scope logic (`connection-providers`)
- **Tenant helpers** — Read the active tenant from `dct` and its flat `roles` and `permissions` claims (`types`)
- **Service & gateway** — Tedix OS gateway-token mint/verify (`gateway-browser-token`) and product session-broker adapters (`product-session-broker`, `mount-session-broker`); shared service-binding request detection lives in `@tedix/worker-kit/request-auth`
- **Raw Descope transport** — `fetch` wrapper with per-attempt timeout, bounded retries, and mutation-safe retry policy for Descope management/token/AIH calls not covered by the SDK (`descope-fetch`)
- **Session broker contract** — auth-host-only surface/origin rules, fixed product RPC entrypoints, opaque navigation handoff, TTLs, and server-only exchange types (`session-broker`)
- **Cookie token extraction** — Read tokens from cookie headers or parsed cookie objects (`utils`)

> Note on capability scopes: the `mcp:*` capability-scope vocabulary, profiles
> (`CAPABILITY_PROFILES`, `resolveTediScopes`, `NON_TEDI_CAPABILITY_SCOPES`) live
> in `@tedix/mcp-shared` (`packages/mcp/src/auth/scopes.ts`), **not** here. This
> package owns `scope-sync` (manifest generation) and the identity/connection
> layers. See the public
> [workers and governance](../../docs/public/workers-and-governance.md) overview.

## Package Exports

```typescript
import { validateToken, isUserToken, isM2MToken } from "@tedix/auth/jwt";
import {
	extractJwtScopes,
	extractTediJwtClaims,
	getTenantId,
	getTenantRoles,
	getTenantPermissions,
} from "@tedix/auth/types";
import type {
	JWTPayload,
	DescopeEnv,
	TediJwtClaims,
	ValidateOptions,
} from "@tedix/auth/types";
import { getManagementClient } from "@tedix/auth/client";
import { descopeFetch } from "@tedix/auth/descope-fetch";
import { buildTedixMcpResourceUri } from "@tedix/auth/aih-audiences";
import {
	assertSessionBrokerIntent,
	buildSessionBrokerAuthorizeUrl,
} from "@tedix/auth/session-broker";
```

## JWT Validation

```typescript
import { validateToken } from "@tedix/auth/jwt";
import {
	getTenantId,
	getTenantRoles,
	getTenantPermissions,
} from "@tedix/auth/types";

const payload = await validateToken(token, {
	projectId: env.DESCOPE_PROJECT_ID,
	baseUrl: env.DESCOPE_BASE_URL, // optional, defaults to https://auth.tedix.dev
});

const tenantId = getTenantId(payload); // active tenant ID (dct)
const roles = getTenantRoles(payload); // roles in the active tenant
const perms = getTenantPermissions(payload); // permissions in the active tenant
```

### Active Tenant Claims

Descope scopes the flat roles and permissions to the active tenant in `dct`:

```json
{
	"dct": "T2abc123",
	"roles": ["admin"],
	"permissions": ["apps:read"]
}
```

The helpers read these claims directly; they do not select a tenant from a
membership list.

## First-Class Tedi Claims

```typescript
import { extractTediJwtClaims } from "@tedix/auth/types";

const { claims, error } = extractTediJwtClaims(payload);
if (claims) {
	// claims.tediId
	// claims.descopeUserId
}
```

Use this helper instead of inferring tedi identity from `sub`. Access-key
exchange flows may use `sub` for the client/access-key subject, while Tedix
identity comes from two places: explicit `descopeUserId` via the JWT template,
and `tediId` / `entityType` via access-key `customClaims`.

## Token Type Detection

```typescript
import { isUserToken, isM2MToken } from "@tedix/auth/jwt";

if (isUserToken(payload)) {
	// Has a subject, is not a tedi, and is not a client without human email.
}
if (isM2MToken(payload)) {
	// Has client_id, with neither sub nor email — machine-shaped token.
}
```

## Consumers

| App         | Usage                                           |
| ----------- | ----------------------------------------------- |
| `apps/api`  | JWT validation middleware, tenant-scoped auth   |
| `apps/os`   | Host-only browser user sessions, JWT validation |
| `apps/mcp`  | Bearer token validation for MCP clients         |
| `apps/tedi` | JWT validation for tedi Worker proxy auth       |

## Environment Variables

| Variable                 | Required | Description                                                         |
| ------------------------ | -------- | ------------------------------------------------------------------- |
| `DESCOPE_PROJECT_ID`     | Yes      | Descope project ID                                                  |
| `DESCOPE_BASE_URL`       | No       | Descope API URL (default: `https://auth.tedix.dev`)                 |
| `DESCOPE_MANAGEMENT_KEY` | No       | Required for management operations; not required for JWT validation |

Bearer header parsing and service-binding trust are transport-edge mechanics
owned by `@tedix/worker-kit/request-auth`; `@tedix/auth/utils` owns cookie
token extraction. Application Workers should not add local Bearer
parsers.

## Tedi key rotation

- Tedix stores both `DESCOPE_ACCESS_KEY` and `DESCOPE_ACCESS_KEY_ID` as encrypted tedi secrets.
- Rotation issues a fresh user-bound Descope access key with explicit tedi custom claims.
- When the previous key id is available, Tedix deactivates the old Descope access key as part of rotation.
- Consumers should use `extractTediJwtClaims()` rather than inferring tedi identity from `sub`.
