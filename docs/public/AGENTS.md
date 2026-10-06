---
sidebar:
  order: 160
title: "AGENTS.md — Tedix Operating Manual"
topic: "Reference"
resource_type: reference
description: "Operating manual for coding agents working in the Tedix source repository."
summary: "Read-first rules and repo map for agents in the source repository"
read_when:
  - Operating a coding agent inside the Tedix repository
  - Looking for the scoped AGENTS.md files and hard policies
visibility: public
---

# Agent guide for the source repository

Tedix runs persistent, organization-owned AI workers on Cloudflare. Start with
`README.md` and `docs/public/index.md`; `docs/public/release-status.md` says
what is available today.

## Start locally

Run `bun run-local` from the repository root. It needs no login and makes no
model calls by default; `docs/public/getting-started.md` lists its options.

For UI-only work, use `bun run --cwd apps/os dev` (fixture data). Never treat
passing local tests as a check of Cloud behavior or a deployment.

## Choose a source path

| Change           | Read first                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| UI               | `apps/os/README.md`, `apps/os/AGENTS.md`, then `apps/os/src/routes/`                                            |
| API              | `apps/api/AGENTS.md`, contract in `packages/api-contract/src/contracts/`, router in `apps/api/src/rpc/routers/` |
| Persistence      | `packages/db/AGENTS.md`, owning `src/schema/` and `src/queries/` modules                                        |
| Worker execution | `apps/tedi-runtime/AGENTS.md`, `src/do.ts` and the relevant adjacent module                                     |
| MCP tools        | `apps/mcp/AGENTS.md`, `src/mcp/handler.ts` and `packages/db/src/schema/tools.ts`                                |
| CLI              | `packages/cli/README.md` and the command's implementation                                                       |

Read the nearest scoped `AGENTS.md`, exact callers, and tests before changing
behavior. Keep unrelated work intact. Contracts and current code take priority
over prose; fix stale instructions when you encounter them.

## Validate the change

- `bun run --cwd <workspace> type-check`: TypeScript source.
- `bun run --cwd <workspace> test:run`: that workspace's tests; follow scoped
  guidance for narrower tests. Never use bare `bun test` on Worker apps.
- `bun run types:check`: generated Worker bindings; regenerate with
  `bun run types:generate`, never by hand.
- `bun run lint:repo`: architecture boundaries.
- `bun run docs:public:check`: public documentation and agent references.
- `bun run scan:secrets`: public source safety.

The pre-push hook selects relevant checks. Do not weaken a failing check to
make it pass. Report exactly what ran, and keep passing tests, a recorded
outcome, and a deployment distinct.

## Hard Invariants

Breaking these is expensive and usually invisible locally. Do not:

- **Use `db.transaction()`.** D1 rejects `BEGIN` (error 7500). `db.batch()`
  is the transaction primitive.
- **Select two columns with the same output name in one query.** D1 batch
  results are object rows and silently collapse duplicates before Drizzle
  maps them. Every query must stay safe when composed into a batch; tests use
  a D1 facade that rejects both idioms.
- **Define oRPC contracts inline in routers.** Contracts live in
  `packages/api-contract/src/contracts/`, schemas in
  `packages/api-contract/src/schemas/`; apps import direct
  `@tedix/api-contract/...` paths.
- **Add barrel files or re-export facades.** Direct imports everywhere. DB
  access goes through `@tedix/db/queries/<domain>` modules — never inline
  Drizzle queries in routers, jobs, services, or workflows
  (`scripts/lint-db-access.ts` enforces this).
- **Hardcode per-tenant behavior in TypeScript.** Config-driven behavior
  (tools, widgets, scopes, policies, schedules) belongs in D1 rows and
  versioned assets; TypeScript provides the engines, validators, renderers,
  and adapters.
- **Name MCP tools anything but verb-first snake_case.** `list_skills`,
  `get_skill`, `run_skill_workflow`. A noun prefix is allowed only for
  multi-product disambiguation (`gmail_send`). Internal oRPC contract keys
  keep their TypeScript `{noun}.{verb}` shape and are exempt.
- **Edit `worker-configuration.d.ts` by hand** — regenerate with
  `bun run types:generate`. Worker config is
  `wrangler.jsonc`, never `.toml`.

## Local work and live access

A local checkout gives no access to any live organization. For permitted live
work, read `docs/public/agent-guide.md`, check `tedix auth status`, and discover
the exact tool and schema before calling it. Consent, MFA, and user presence
stay with the human; other approvals go to the designated approver.

Maintainers commit directly to `main` after validation. Pull requests are
disabled; agents must not create them. Proposals start as issues. See
`CONTRIBUTING.md`. Never invent a Work Item or agent identity.

## Deployment boundary

This repository owns product source and example configuration, not the live
Tedix Cloud installation. Managed releases run from `tedix-hq/tedix-cloud-ops`,
which owns the guarded deployment workflow, live configuration and credentials.
Do not hand-deploy Tedix Cloud from this checkout or add its account, database,
organization or resource IDs, secret references, or private runbooks here.
Keep checked-in Worker configuration usable as examples, with placeholders
instead of live installation coordinates. Never commit real `.env` files,
`.dev.vars`, credentials or customer data; `.env.example` contains key names
and placeholders only. Use fictional tenant identities in tests and examples.

Deploying into your own Cloudflare account is experimental operator work. Follow
`docs/public/installation-manifests.md` and
`docs/public/self-hosted-boundary.md` only when deployment is the task. A source
checkout is not authorization to operate Tedix Cloud.
