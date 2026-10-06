# @tedix/session-broker

Cloudflare Worker that implements Tedix's Browser Session Authority through the
auth-host-only Session Broker protocol. Tedix Identity UI remains in `apps/os`;
this runtime owns no general product UI.

## Overview

`SessionRotationOwner` is one SQLite-backed Durable Object per opaque browser
session. It coalesces identical resume/select/logout operations and queues
different operations onto the newest rotated refresh generation. Resume takes
no caller tenant; logout invalidates the lineage and is replay-idempotent. Raw
refresh credentials remain in active RPC memory only; its durable state
contains a monotonic generation and one-way replay fingerprints. The separate
intent object may retain one session JWT behind a random authorization code.
The code is usable for at most 30 seconds; exchange clears it atomically and a
Durable Object alarm clears an unexchanged grant at expiry.

`OsSessionBroker`, `CliSessionBroker`, `DocsSessionBroker`, and
`CmsSessionBroker` are the active surface-fixed Service Binding entrypoints.
`SessionIntentOwner` holds one ten-minute intent and at most one 30-second,
single-use session or logout grant. The public Worker accepts a form `POST`
carrying the fresh `session_token` (the primary credential handoff) or a
top-level `GET` navigation to `auth.tedix.dev/tedix/session/authorize`, plus
`/tedix/session/outbound/callback` and `/tedix/session/health`; every other
path returns `404`.

OS, private Docs, the CLI picker, and CMS are bound to their surface-specific
broker entrypoints. Descope's server-set `DSR` cookie
(`Domain=auth.tedix.dev`) is a bootstrap-only input: the broker adopts it once
— resolving duplicate cookie scopes by matching the fresh session JWT `sub`
and newest `iat`, failing closed without a fresh session — and thereafter
rotates under its own `TEDIX_DSR` cookie as the sole steady-state refresh
authority on `auth.tedix.dev`. Every rotation also re-sets a Descope-readable
`DSR` twin under Descope's exact cookie identity (`Domain=auth.tedix.dev`,
`Path=/`) so authenticated Descope flows (inbound-app consent, step-up) can
hydrate via their own refresh; `selectAuthoritativeRefreshValue` unifies both
cookie families and adopts a flow-advanced successor instead of replaying a
stale value. Products receive their own host-only sessions
through one-time grants.

Cookie serialization derives the Descope-readable twin's domain from the
already-routed broker request hostname. Expiry clears host-only and exact-host
cookies; only `auth.tedix.dev` also clears historical `.tedix.dev` cookies.
This is an own-installation prerequisite, not custom-domain deployment support:
the public host allowlist, product target origins, and central login redirects
still require portability work. The broker and Descope must share the auth host
so their `DSR` writes replace the same cookie identity.

Product sessions remain the sole browser credential accepted by their Worker.
Products contain no direct Descope refresh, tenant-selection, or session-cookie
fallback.

## Validation

```bash
bun run test:ci
bun run type-check
```

`cloudflare.config.ts` declares both Durable Object classes as live SQLite
`exports`. Keep each entry and its storage: Cloudflare rejects a storage change,
and a `deleted` state drops the namespace.

For installation constraints, see the public
[self-hosted boundary](../../docs/public/self-hosted-boundary.md).
