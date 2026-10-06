# @tedix/cms

Site Builder Worker for the Tedix CMS (Emdash): an MCP server that lets a tedi (or a
human operator) edit, preview, build, and deploy a tenant's site theme.

> **See also:** the public
> [CMS first-use guide](../../docs/public/cms.md) and
> [Cloudflare architecture](../../docs/public/cloudflare-architecture.md) for
> the platform boundary and [AGENTS.md](AGENTS.md) for authoring/behavior rules.

## Overview

`apps/cms` (`tedix-cms`, served at `builder.tedix.dev`) is a Cloudflare Worker
that exposes tenant theme operations as MCP tools over Streamable HTTP at
`/mcp`. It is the control-plane side of Emdash: theme file reads/writes, hot
theme (live preview) revisions, artifact-repo provisioning, template
resync/propagation, preview containers, builds, and deploys/rollbacks all go
through this Worker. It runs entirely on Cloudflare (Workers + Durable
Objects + Containers + Workflows) — no separate Node process.

A per-org `SiteBuilderSandboxRuntime` (Cloudflare Sandbox container, backed by
`@cloudflare/sandbox`) runs the Astro dev server
for live preview and `astro build` for deploys. `apps/cms-runtime`
(`CMS_DISPATCH` service binding) serves the built tenant sites at runtime;
this Worker only handles authoring and deploy orchestration.

## Authentication & Org Routing

Requests to `/mcp` authenticate via Descope JWT (`Authorization: Bearer`) or,
for internal calls from `apps/mcp`, a `PLATFORM_SERVICE_TOKEN` service token
carrying a forwarded human JWT (`X-Forwarded-Authorization`). The target org
is resolved from `X-Tedix-Connection-Label` or `?org=` and authorized against
the caller's Descope tenant memberships (with a 5-minute in-memory cache for
Descope user-load lookups), not per-tenant Descope Console scopes — this
scales to N tenants without manual console configuration per customer.

## MCP Tools

Exposed via `buildSiteBuilderMcpServer` (`src/agent/tools.ts`), grouped by area:

- **Service keys** — provision a CMS service key for an org.
- **Theme files** — list/read/write/delete theme files, batch-write multiple
  files.
- **Hot theme** — read/write the live-preview "hot theme" revision, list
  revisions, roll back.
- **Theme artifacts** — provision an artifact repo, check/cancel seed status,
  load exact source into the disposable sandbox, commit editable files with an
  expected-head check, and read commit status.
- **Template sync** — resync a theme from the template, diff sandbox vs
  template, propagate template files to all orgs.
- **Fleet status** — inspect CMS fleet status across orgs.
- **Preview** — start/check/stop a theme preview container, run and
  check/cancel commands inside the preview container.
- **Build & deploy** — build a theme, check/cancel a build, deploy to live
  CMS, check deploy status, list versions, roll back a deployed version.

A subset of read-mostly tools (`SANDBOX_FREE_CMS_PROXY_TOOLS` in
`src/agent/cms-proxy-runtime.ts`) can be served without spinning up the
sandbox container, via `callSandboxFreeCmsProxyTool` in `src/agent/cms-proxy.ts`.

`src/agent/blog-generation.ts` adds Gemini-backed MCP tools for generating
blog posts (with FAQ items) through the CMS REST proxy.

## HTTP Routes

| Route                              | Description                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | Liveness check                                                                                                    |
| `POST/GET/DELETE /mcp`             | MCP Streamable HTTP endpoint (theme/build/deploy tools); `GET` without an SSE `Accept` header returns server info |
| `GET /api/image-generation/:jobId` | Poll an `ImageGenerationWorkflow` job's status                                                                    |
| `ALL /preview/:orgSlug/*`          | Proxies to the org's `SiteBuilderSandboxRuntime` container on port 4321 (Astro dev server)                        |

## Cloudflare Workflows

- **`DeployWorkflow`** (`DEPLOY_WORKFLOW`) — durable, retryable theme deploy:
  preflight → build-and-snapshot → publish-bundle → health-check →
  cleanup.
- **`ImageGenerationWorkflow`** (`IMAGE_GENERATION_WORKFLOW`) — durable image
  generation job.

Both persist status snapshots to `SITE_BUILDER_STORAGE` (R2) alongside the
Workflow's own instance status, so `mapWorkflowStatus`/
`mapImageGenerationStatus` can report phase/message/history even mid-run.

## Bindings (cloudflare.config.ts)

| Binding                     | Type                       | Description                                                     |
| --------------------------- | -------------------------- | --------------------------------------------------------------- |
| `DB`                        | D1                         | Platform site and bundle metadata                               |
| `SITE_BUILDER_STORAGE`      | R2                         | Theme files, service keys, deploy/image-gen status snapshots    |
| `BUNDLES_BUCKET`            | R2                         | Built theme bundles and versions                                |
| `ARTIFACTS`                 | Cloudflare Artifacts       | Artifacts namespace from the installation manifest              |
| `SITE_BUILDER_SANDBOX`      | Durable Object / Container | `SiteBuilderSandboxRuntime` — per-org Astro dev/build container |
| `DEPLOY_WORKFLOW`           | Workflow                   | `DeployWorkflow`                                                |
| `IMAGE_GENERATION_WORKFLOW` | Workflow                   | `ImageGenerationWorkflow`                                       |
| `CMS_DISPATCH`              | Service binding            | The CMS runtime Worker that serves built tenant sites           |

Required secrets (`bindings.secret()`): `DESCOPE_PROJECT_ID`,
`DESCOPE_BASE_URL`, `DESCOPE_MANAGEMENT_KEY`, `CF_ACCOUNT_ID`,
`PLATFORM_SERVICE_TOKEN`,
`CMS_INTERNAL_AUTH_TOKEN`, `GEMINI_API_KEY`, `CF_AI_GATEWAY_TOKEN`.

## Development

```bash
bun run dev              # snapshot template, vp dev (port 3013)
bun run type-check       # verify snapshot, generate binding types, then tsc --noEmit
bun run build            # vp build; also builds the Sandbox container image
bun run snapshot:template  # regenerate the snapshot for every installed scaffold
bun run templates:install  # frozen install for every installed scaffold
bun run test             # vitest run
```

These commands support source development and tests. Starting this Worker alone
does not create a usable CMS preview: authoring needs a provisioned tenant, theme
bundle, storage, and authenticated connection; theme preview/build also needs
the Sandbox container. The root local launcher does not provision that CMS setup.
Use an invited Cloud site for the first editorial trial described in the guide above.

Managed production releases build product `main` through the guarded workflow
in `tedix-hq/tedix-cloud-ops`; do not hand-deploy from this checkout. This surface
requires Docker to build its container image. Every
Worker secret must be declared in `cloudflare.config.ts`: `cf deploy` deletes
any live secret the config omits.

`src/template-snapshot.ts` is generated (never hand-edited) — it bundles the
CMS starter template so Site Builder can ship it to new tenants without a build-time
filesystem read.
