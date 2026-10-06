# @tedix/os

The Tedix OS web application.

## Overview

Tedix OS is the main working interface for durable company work. Activity is
the default view; Canvas, Blueprints, Outputs, Team, Skills, Apps, Brain, and
Audit are routes in the same authenticated shell. Settings and Admin settings
complete that shell without splitting authority across a second application:
personal appearance is browser-local, while durable tenant configuration uses
the canonical control plane. `Cmd/Ctrl+K` searches routes and projected resources.
This application renders and operates canonical Tedix API and MCP state. It
does not own a second planner, agent runtime, workflow engine, connector
system, or artifact store.

Outputs are edited natively rather than as raw JSON. Documents provide rich
text and image authoring; sheets provide multi-tab workbooks, formulas,
selection and formatting; presentations provide templates and a draggable
16:9 component canvas with notes and presentation mode. The same editors run
inside Canvas collaborative drafts, while explicit revision commits remain the
canonical D1 boundary. Rich payloads retain the required semantic projections
used by CLI/MCP tools and exports.

The application is in production as the single multi-tenant `tedix-os` Worker,
serving every provisioned tenant at `{slug}.os.tedix.dev` plus the central
launcher `os.tedix.dev`.

The two origin classes are intentionally different. `os.tedix.dev` owns sign-in,
the active/provisioned organization picker, and `/cli/login`; it refuses tenant
API routes and never renders the operational shell. `{slug}.os.tedix.dev` owns
the full OS and binds every API request to that hostname's organization. An
unauthenticated tenant deep link returns through the apex, then resumes only
after the launcher proves the signed-in user may open that provisioned tenant.
The handoff is broker-owned: each OS origin navigates through a same-origin
`/auth/session-broker/start`, the Browser Session Authority serializes Descope
resume or tenant selection, and the Worker stores the result in the origin's
`__Host-tedix-os-session` HttpOnly cookie. Browser code never reads the session
JWT. Descope mounts locally where a journey needs it (login, consent,
invitation, step-up, end-user widgets), never app-wide, and always through the
one canonical non-persisting provider
(`src/shared/descope-provider.tsx`, `persistTokens={false}` +
`autoRefresh={false}`). The Worker
translates the product session to Descope's canonical `DS` name only while
forwarding to trusted API, MCP, and collaboration bindings. The CLI picker has
its own `__Host-tedix-cli-session`; choosing a slug does not mint or replace the
subsequent MCP OAuth PKCE grant.

The shared login, onboarding, organization selection, CLI authorization, and
inbound consent presentation is called **Tedix Identity**. It is an OS mode,
not a second application, and does not merge the distinct OS, CLI, CMS, Docs,
or OAuth credential boundaries.

Tedix and a tenant application can remain open in separate tabs without a global tenant
switch, and each surface renews through the single auth-host owner during the
last 60 seconds of its session. The old `/auth/prepare-tenant` and
`/auth/tenant-session` paths do not exist. Refresh cookies live only on
`auth.tedix.dev` — the broker rotates its own HttpOnly `TEDIX_DSR`, with
Descope's `DSR` as a bootstrap-only input. The
[session broker](../session-broker/README.md)
owns rotation and the Descope-readable cookie twin.

## Development

```sh
bun install
bun run --cwd apps/os dev
bun run --cwd apps/os test
bun run --cwd apps/os type-check
bun run --cwd apps/os build
```

`bun run --cwd apps/os dev` is the fixture-backed, no-login UI loop. Use
`tenant.localhost:3010` to exercise tenant host resolution without cloud data.

For isolated API and D1 behavior, run `bun run-local` from the repository root.
Its default mode uses local state and no model credentials.

## Build configuration

The SPA bakes its public identity into the bundle at build time and has **no
Tedix Cloud default**. `dev/build-config.ts` resolves each value in this order
and fails the build, naming the missing variables, when none applies:

| Variable                         | Meaning                              | Local-lane sentinel          |
| -------------------------------- | ------------------------------------ | ---------------------------- |
| `TEDIX_BUILD_API_URL`            | Direct API origin for bearer calls   | `http://localhost:3030/api`  |
| `TEDIX_BUILD_DESCOPE_PROJECT_ID` | Descope project of this installation | `local-development-disabled` |
| `TEDIX_BUILD_DESCOPE_BASE_URL`   | Descope base URL (auth host)         | `http://127.0.0.1:9`         |

1. The `TEDIX_BUILD_*` environment variable, when set.
2. The sentinel above, only in the isolated local lane (`bun run-local`, which
   sets `TEDIX_BUILD_LOCAL_DEMO_ENABLED=true`) and the fixture dev server.
3. The text bindings of `cloudflare.config.ts` for the build mode (`API_URL`,
   `DESCOPE_PROJECT_ID`, `DESCOPE_BASE_URL`), the same non-secret Worker
   config `src/worker.ts` runs on. This is how a plain production
   `bun run build` gets its values. The checked-in config carries the
   `configured-via-private-overlay` placeholder, which counts as unset.

`TEDIX_BUILD_DESCOPE_STYLE_ID` stays optional and env-only; empty means the
project default.

## Frontend stack

- **Application model:** client-rendered React application. The Worker owns
  hostname, session, API, MCP, collaboration, and asset routing; it serves the
  same route shell for browser navigation.
- **Routing:** TanStack Router file routes generated from `src/routes`, with
  automatic route splitting, nested auth/session/tenant layouts, typed search,
  loader prefetch, scroll restoration, and global pending/error/not-found
  boundaries.
- **Server data:** TanStack Query over oRPC. Core Workspace/output/Blueprint/run
  routes share generated definitions in `src/lib/os-query-options.ts`; legacy
  component-local API keys remain migration debt. D1/API remains canonical;
  Query is a browser cache and live projections reconcile by invalidating or
  replacing exact canonical keys.
- **UI:** Cloudflare Kumo behind app-local `src/components/kumo/*` adapters,
  including shared `Page`, `PageHeader`, and `PageActions` composition.
- **Live editing:** the operational-transformation (OT) `CollabRoom` and browser-only editors are explicitly
  owned, disposed on navigation, and committed through canonical revision
  contracts.

Tedix OS intentionally does not use TanStack Start today. It is an authenticated,
editor-heavy workspace whose useful state begins after session establishment.
Move OS to Start only for a measured server-rendering or server-function need;
earlier framework choices are historical evidence, not a reason to make the
package lists match.

## Architecture

See the public [Cloudflare architecture](../../docs/public/cloudflare-architecture.md)
for the API, runtime, storage, and frontend boundaries.
