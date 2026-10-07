# @tedix/api

Tedix's Cloudflare Worker for the tenant control plane, Home/kernel conversations,
shared data access, and durable workflow orchestration.

## Overview

Tedix OS, the CLI, MCP apps, and internal Workers call contract-backed API
procedures. The API owns authentication, authorization, orchestration, and
response normalization; shared D1 queries live in `@tedix/db`. The embedded
widget's conversational runtime is owned by `apps/tedi-runtime`.

The implementation is organized around these boundaries:

| Source                                               | Responsibility                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| [src/index.ts](src/index.ts)                         | Worker entrypoint, Durable Object exports, and lazy workflow shims |
| [src/worker-app.ts](src/worker-app.ts)               | Hono routes, RPC/REST handlers, scheduled and queue dispatch       |
| [src/rpc/routers/index.ts](src/rpc/routers/index.ts) | Lazily loaded contract namespaces                                  |
| [src/rpc/orpc.ts](src/rpc/orpc.ts)                   | Request context and authentication/authorization primitives        |
| `src/kernel`                                         | Durable Home/kernel transport and execution infrastructure         |
| `src/workflows`                                      | Durable orchestration implementations                              |
| `src/services`                                       | Application services shared by routes and workflows                |
| `src/integrations`, `src/webhooks`                   | Provider clients and inbound callbacks                             |

Contracts and schemas live in
[@tedix/api-contract](../../packages/api-contract).
Import contracts for typed clients; the `@tedix/api/rpc` export points to the
server implementation tree.

## HTTP surfaces

Routes are registered in [src/worker-app.ts](src/worker-app.ts). Authentication
and authorization are specific to each procedure or endpoint.

| Path                                                                   | Purpose                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `/rpc/*`                                                               | oRPC procedures used by Tedix clients and Workers      |
| `/v1/*`                                                                | Explicitly published REST operations, a subset of RPC  |
| `/openapi.json`, `/docs`                                               | Public REST specification and API reference UI         |
| `/health`                                                              | Worker health and revision metadata                    |
| `/kernel/ws-token`                                                     | Scoped token issuance for kernel voice                 |
| `/kernel/voice/*`                                                      | Home voice transport and transcription                 |
| `/webhooks/descope/audit`, `/webhooks/stripe`, `/webhooks/stripe/test` | Provider callbacks with endpoint-specific verification |

Media, artifact, export, sharing, and branding endpoints also live in the route
registration file. The REST operation inventory is
[src/rpc/public-rest-operations.ts](src/rpc/public-rest-operations.ts).

## Development and validation

From this directory:

```bash
bun run dev
bun run types:check
bun run type-check
bun run test:run
```

Install workspace dependencies from the repository root with
`bun install --frozen-lockfile`. Default development uses isolated local state
and omits remote-only capabilities.

Non-secret configuration and binding declarations live in
[wrangler.jsonc](wrangler.jsonc); secrets use the installation's configured secret provider.
Own-account deployment requires an installation manifest and operator-owned
resources; see [installation manifests](../../docs/public/installation-manifests.md)
and the [self-hosted boundary](../../docs/public/self-hosted-boundary.md).

## References

- [Cloudflare architecture](../../docs/public/cloudflare-architecture.md)
- [Getting started](../../docs/public/getting-started.md)
- [Agent operating rules](AGENTS.md)

Licensed under AGPL-3.0-only.
