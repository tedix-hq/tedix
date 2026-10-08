---
summary: "Tedix Worker topology, package boundaries, and cross-service communication map"
read_when:
  - Checking how apps and packages fit together
  - Updating service bindings, Worker topology, or runtime/control-plane boundaries
title: "Architecture overview"
---

# Architecture Overview

Tedix is a set of Cloudflare Workers that share one platform D1 database and
talk to each other over Service Bindings. This page maps the Workers, the
Cloudflare primitives each one uses, and the boundaries between them.

## Product Shell

[Tedix OS](product/tedix-os.md) (`apps/os`) is the main interface. One
multi-tenant Worker serves every `{slug}.os.tedix.dev` organization origin and
the `os.tedix.dev` launcher; there is no per-tenant Worker fleet.

- The launcher is a tenant-neutral sign-in and launch page. It lists the
  signed-in user's memberships and refuses ordinary tenant APIs.
- Each organization host binds API requests to its resolved organization and
  keeps its own host-only session.
- `apps/session-broker` owns `auth.tedix.dev/tedix/session/*`. It holds the
  rotating refresh credential and serializes refresh per browser handle.
  Product Workers call it through named Service Binding entrypoints and never
  read the refresh credential.

```text
{slug}.os.tedix.dev   → apps/os → Tedix API + tenant MCP
tedix CLI             → user / tedi / external-agent identity → tenant MCP
```

The shell renders and edits state; it does not own it. Work Items, kernel runs,
tedis, MCP policy, artifacts, memory, approvals, and audit live in the API and
runtime services behind it.

## Apps

| App                                   | Host                                   | Purpose                                                                               |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/os`                             | `os.tedix.dev`, `*.os.tedix.dev`       | Product frontend (TanStack Router + Query)                                            |
| `apps/session-broker`                 | `auth.tedix.dev/tedix/session/*`       | Browser session handoff and refresh rotation                                          |
| `apps/api`                            | `api.tedix.dev`                        | oRPC control plane, Workflows, kernel Durable Object; shared D1 through `packages/db` |
| `apps/mcp`                            | `*.mcp.tedix.dev`                      | Stateless multi-tenant MCP edge; tools loaded from D1                                 |
| `apps/tedi`                           | `*.tedi.tedix.dev`                     | Tedi edge/control Worker: routing, auth, MCP, admin APIs, status/wake, proxying       |
| `apps/tedi-runtime`                   | internal                               | The Agent runtime (Cloudflare Agents/Pi Durable Durable Object)                       |
| `apps/tedi-workstation-runtime`       | internal                               | Container workstation leases for coding and shell work                                |
| `apps/tedi-workstation-egress-broker` | internal                               | GitHub App credentials and scoped Git transport for workstations                      |
| `apps/artifact-gateway`               | signed artifact routes                 | Cookie-isolated `GET`/`HEAD` byte boundary for agent-authored content                 |
| `apps/skill-runtime`                  | `skill-runtime.tedix.dev`              | Executable skill workflows (`@cloudflare/dynamic-workflows` + Worker Loader)          |
| `apps/mcp-ui`                         | `mcp-ui.tedix.dev`                     | MCP Apps UI renderer (Astro + React islands, json-render)                             |
| `apps/widget`                         | `widget.tedix.dev`                     | Framework-neutral embeddable Tedi widget                                              |
| `apps/landing`                        | `tedix.dev`, `www.tedix.dev`           | Public marketing site; remains active until its CMS replacement is verified           |
| `apps/cms`, `apps/cms-runtime`        | `builder.tedix.dev`, `*.cms.tedix.dev` | CMS studio and tenant site runtime; see [CMS](emdash/cms.md)                          |
| `apps/docs`, `apps/docs-runtime`      | `*.docs.tedix.dev`                     | Multitenant docs control plane and static serving plane                               |

## Service Bindings

All Worker-to-Worker calls use Service Bindings. Each app's Worker config
(`wrangler.jsonc` or `cloudflare.config.ts`) is the authoritative list.

| Binding                    | Source → target                     | Carries                                                |
| -------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `API_SERVICE`              | most Workers → API                  | Data reads, state reporting                            |
| `TEDI_SERVICE`             | API, MCP, Tedi Runtime, Tedi → Tedi | Runtime operations, tedi-to-tedi mesh (`X-Tedix-Host`) |
| `TEDI_RUNTIME_SERVICE`     | Tedi, Skill Runtime → Tedi Runtime  | Named entrypoints into the Agent runtime               |
| `MCP_SERVICE`              | OS, API, Skill Runtime → MCP        | Tenant MCP, health checks, skill-workflow MCP bridge   |
| `CMS`, `CMS_DISPATCH`      | API, MCP → CMS; CMS → CMS Runtime   | Studio operations; tenant bundle dispatch              |
| `DOCS`                     | API, MCP → Docs                     | Docs control-plane operations                          |
| `SKILL_RUNTIME`            | API → Skill Runtime                 | Run, status, and cancel skill workflows                |
| `WORKSTATION_EGRESS_PROXY` | Workstation Runtime → Egress Broker | GitHub token issuance and Git transport                |
| `*_SESSION_BROKER`         | OS, CLI, CMS, Docs → Session Broker | Named broker entrypoint per product surface            |

OS browser RPC is same-origin to the OS Worker, which verifies the session and
tenant before forwarding to the API.

## Cloudflare Primitives

Each primitive has one job. Do not collapse the tedi runtime into one primitive
because another product happens to use it internally.

| Primitive                     | Where                                                                                      | Job                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Durable Objects               | `apps/tedi-runtime`, `apps/tedi-workstation-runtime`, `apps/api`                           | Agent identity and conversation state, workstation lease ownership, org kernel turns          |
| Containers (Computer/Sandbox) | `apps/tedi-workstation-runtime`, `apps/docs`, `apps/cms`                                   | Workstation filesystem and processes; isolated docs builds; CMS deploy pipeline               |
| Dynamic Worker Loader         | `apps/mcp`, `apps/tedi`, `apps/tedi-runtime`, `apps/skill-runtime`, `apps/cms-runtime`     | Short-lived tenant code: Code Mode, stored code tools, skill workflows, CMS bundles           |
| Workflows                     | `apps/api`, `apps/cms`, `apps/docs`, `apps/mcp`, `apps/tedi-runtime`, `apps/skill-runtime` | Durable jobs: catalog sync, imports, scans, evals, publication, MCP tasks, chat turns, skills |
| Browser Rendering             | `apps/tedi`, `apps/api`                                                                    | Headless browser sessions through the `BROWSER` binding                                       |

Worker Loader isolates are the home for stateless or step-scoped code. OS
processes, repo checkouts, system dependencies, and long-lived ports belong to
workstation leases ([Workstations over bodies](../../decisions/workstations-over-bodies.md)).
Use Workflows whenever an operation needs replay, retries, sleeps, or
event waits; add `@cloudflare/dynamic-workflows` only when the Workflow must
run tenant-authored code.

For exclusive claims or hot runtime assignment, use D1 compare-and-swap writes,
not KV.

## Planes And Data Flow

- **Control plane:** OS, API, MCP, and the `apps/tedi` edge. Stateless
  request/response Workers that scale automatically.
- **Runtime plane:** Agent runtime Durable Objects (hibernate and wake on
  request) and workstation containers (scale to zero).

```text
OS  → API → @tedix/db/queries/<domain>[/<capability>] → shared D1
API → Tedi edge → Agent runtime DO  or  workstation lease
Tedi edge → API → query helper → D1   (runtime projections, usage events)
MCP → API → Tedi edge → runtime/workstation   (live tool execution)
```

Storage roles: D1 holds control-plane facts; R2/Artifacts hold large immutable
payloads; Durable Object SQLite holds private runtime state; workstation files
are scratch until committed or captured as an artifact. See
[Data model](platform/data-model.md).

## Runtime

`apps/tedi-runtime` is the one tedi runtime: a Cloudflare Agents/Pi Durable Worker
and Durable Object (`AgentTediDO` in `apps/tedi-runtime/src/do.ts`) for chat,
MCP, email, voice, and channel work. The loop has no default step limit; a
ceiling applies only when governance sets `maxIterationsPerTask`, bounded by the
`MAX_CHAT_STEPS` backstop. Context is bounded by compaction, and every early
stop ends with one tools-off final report
(`apps/tedi-runtime/src/facet-turn-stop.ts`). Coding and shell work attach a
workstation lease instead of switching runtimes. Cognitive state is recorded in
the runtime-neutral `tedi_runtime_events` ledger. See
[Agent runtime](tedi/agent-runtime.md).

`apps/tedi` routes into the runtime Durable Object or the workstation binding
and owns auth, MCP, admin APIs, status/wake, sync, and mesh.

### Chat backends

| Surface                        | Backend                                                                  | Loop owner                     |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------ |
| Tedix OS chat, `tedix` CLI/TUI | Home/kernel in `apps/api` (`apps/api/src/rpc/routers/kernel/`, `KERNEL`) | Kernel router; one answer/turn |
| Embedded widget                | Pi `ConversationFacet` in `apps/tedi-runtime`                            | native Pi Durable loop         |

The two backends are deliberate: the kernel routes, delegates, and handles
approvals and Work Items ([Agentic kernel](../../decisions/agentic-kernel-architecture.md));
the widget needs the tool-capable Pi loop. They share only packages:
`@tedix/workers-ai` (the one model provider), `@tedix/context-core` (the one
compaction boundary and overflow classifier), and `@tedix/chat-transport`
(transcript reducer). Both bound history by token pressure against the model
window, not by turn count.

Executable skills run in `apps/skill-runtime`: one static `SkillWorkflow`
class loads pinned tenant code into a Worker Loader isolate that receives only
capability stubs; see [Skills](cognition/skills.md).

### MCP

`apps/mcp` builds a fresh MCP server per request (`mountMcp()` in
`@tedix/mcp-shared/transport`) with no Durable Object on the tool path. Tools,
widgets, CSP, and scopes are D1 rows maintained by catalog workflows in
`apps/api/src/workflows`. The MCP Worker serves only protected-resource
metadata (`/.well-known/oauth-protected-resource`); authorization-server
discovery, client registration, and authorization are hosted by the identity
provider. See [MCP runtime](mcp/runtime.md) and [Auth](platform/auth.md).

## Deploy Target

Every Worker deploys to one named Wrangler environment, `production`.
`scripts/lint-wrangler.ts` rejects any `env.staging`, because a staging block
that binds the same D1 and R2 is not isolation. Preview work belongs in local
development ([Development](development.md)).
