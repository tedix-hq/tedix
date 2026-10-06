# Tedi Edge Worker

> `apps/tedi` — public edge/control Worker for `*.tedi.*` traffic. Every tedi is the **Agent runtime** served by `apps/tedi-runtime` (Cloudflare Agents Durable Object with native Pi facets). OS/process capability is an additive Sandbox **workstation lease** in `apps/tedi-workstation-runtime`.

## What it does

The tedi edge Worker receives wildcard subdomain requests, resolves the tedi from D1 (via `@tedix/db`), applies auth/control-plane policy, and forwards every normal tedi request to the Agent runtime in `apps/tedi-runtime` via `TEDI_RUNTIME_SERVICE` (fail-loud 503 when unbound). A tedi that requests a workstation leases `TediWorkstationRuntimeSandbox` from `apps/tedi-workstation-runtime`.

```
{tedi}.{owner}.tedi.tedix.dev → apps/tedi → apps/tedi-runtime (Agent runtime: Cloudflare Agents Durable Object with native Pi facets, DO)
workstation request    → apps/tedi → apps/tedi-workstation-runtime/TediWorkstationRuntimeSandbox DO → /home/tedi/workstation
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  *.tedi.tedix.dev (wildcard DNS)            │
│  e.g. research.acme.tedi.tedix.dev           │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  Tedi edge Worker (this app)                │
│  - Parse subdomain ({tedi}.{owner})         │
│  - @tedix/db: getTediByRuntimeSlug()        │
│  - Auth, admin API, runtime proxy           │
│  - Agent runtime service binding            │
│  - Workstation DO binding by script_name    │
│  - R2 namespace: tedis/{tediId}/*           │
└──────────────┬──────────────────────────────┘
               │  every tedi
┌──────────────▼──────────────────────────────┐
│  apps/tedi-runtime  (Agent runtime)            │
│  - Agents DO + native Pi cognitive facets   │
│  - chat, MCP, email, scheduling, workflows  │
│  - persistent memory, Artifacts repo        │
└──────────────┬──────────────────────────────┘
               │  additive: workstation lease
┌──────────────▼──────────────────────────────┐
│  apps/tedi-workstation-runtime              │
│  - Tedix Sandbox workstation container      │
│  - /home/tedi/workstation repo shell        │
│  - Native Sandbox execution, git, gh        │
└─────────────────────────────────────────────┘
```

## Monorepo Integration

| Package                              | Usage                                                           |
| ------------------------------------ | --------------------------------------------------------------- |
| `@tedix/db`                          | D1 schema, `getTediByRuntimeSlug()` query, tedi types           |
| `@tedix/context-core/tedi-workspace` | Render SOUL.md, IDENTITY.md, USER.md from D1-supplied templates |
| `drizzle-orm`                        | D1 client for tedi resolution                                   |

## Relationship to Other Apps

```
apps/os         →  apps/api  →  apps/tedi  →  apps/tedi-runtime  (Agent runtime, default)
                                      ├──────→  apps/tedi-workstation-runtime  (workstation lease)
control plane      D1/oRPC       edge/API      Agent runtime + additive workstation
```

- **apps/os** manages tedi config through the administrative workspace
- **apps/api** stores config in D1, exposes oRPC procedures
- **apps/tedi** reads D1, handles auth/control routes, and proxies traffic
- **apps/tedi-runtime** owns the Agent runtime — the Cloudflare Agents Durable Object with native Pi facets every tedi runs on
- **apps/tedi-workstation-runtime** owns the Tedix Sandbox workstation DO class and image for additive workstation leases

## Domains

| Environment                 | Tedi edge               |
| --------------------------- | ----------------------- |
| Isolated local development  | `http://localhost:3007` |
| Operator-configured ingress | `*.tedi.example.com`    |
| Tedix Cloud                 | `*.tedi.tedix.dev`      |

Optional development ingress requires operator-owned DNS, certificates and
explicitly allowed hosts. It is separate from the isolated local Worker.
Set `TEDIX_DEV_ALLOWED_HOSTS` to a comma-separated list of those development hosts.

## API Routes

### Public (no auth)

- `GET /health` — Worker health

### Admin (requires Service Binding — internal worker-to-worker only)

- `POST /api/admin/workstation/*` — Canonical workstation operations, owned by
  [the workstation router](src/routes/admin/workstation/router.ts), whose
  handlers live beside it by group (`lease.ts`, `files-exec.ts`, `process.ts`)
  over shared helpers in `shared.ts`.
- `POST /internal/workstation/reap` — Separately authenticated idle-lease cleanup,
  owned by [the reaper route](src/routes/workstation-reaper.ts).

### Catch-all proxy

All other requests are forwarded to `apps/tedi-runtime` through
`TEDI_RUNTIME_SERVICE`.

**Auth paths (3 ways to authenticate):**

1. **Tedi V2 JWT** — tedi-owned runtime identity.
2. **Gateway browser token** — Tedix OS-scoped browser token for runtime WebSockets.
3. **Descope JWT** — user bearer token or `id_token` cookie, validated at the
   Agent-runtime edge.

**Security (fail-closed):**

- JWT access requires tedi to have a non-null `organizationId` (rejects 403 otherwise)
- JWT tenant claim must match `organizationDescopeTenantId` (org ownership verification)
- Gateway browser tokens stay scoped to the tedi/session audience.

## Running locally

```bash
cd apps/tedi
bun run dev  # Starts on http://localhost:3007
```

`bun run dev` uses the isolated local configuration from `scripts/dev-local.ts`.
See [Getting started](../../docs/public/getting-started.md#run-tedix-locally)
for full-stack startup.

### Local runtime bindings

Agent requests use the Worker service binding `TEDI_RUNTIME_SERVICE`; run
`apps/tedi-runtime` for local Agent execution. Workstation operations use
`TEDI_WORKSTATION_RUNTIME_SANDBOX`, a Durable Object binding that names
`apps/tedi-workstation-runtime` as its Worker in `cloudflare.config.ts`.
Run that Worker for local workstation execution.

Agent requests forward through `TEDI_RUNTIME_SERVICE`. The edge returns 503
when the runtime service binding is missing.
Workstation operations use the separate Sandbox runtime binding. Browser
Rendering and Worker Loader capabilities belong to `apps/tedi-runtime`.

## Configuration

`cloudflare.config.ts` owns bindings, routes, and vars by mode. This Worker
hosts no Durable Object class: its old `Sandbox` and `DevSandbox` classes were
deleted, so it declares no `exports`. Never declare either class again.

```bash
bun run type-check
bun run test:run
```
