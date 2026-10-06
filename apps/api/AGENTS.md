---
summary: "apps/api scoped rules: oRPC layering, the thin-entrypoint contract, and the traps that break deploys"
read_when:
  - Touching anything under apps/api/
  - Adding or changing an oRPC procedure, middleware, or error code
  - Editing src/index.ts, src/worker-app.ts, or the cron handler
title: "apps/api agent guide"
---

# apps/api Agent Guide

Root rules live in `/AGENTS.md`. This file owns only what is specific to this
app — the constraints that are load-bearing and expensive to rediscover.

Start with `apps/api/README.md`, `src/rpc/orpc.ts` (authorization), and
`packages/db/AGENTS.md` (D1 ownership and query rules).

## The thin-entrypoint contract

`src/index.ts` must stay minimal. Cloudflare rejects a deploy whose _script
startup_ exceeds its CPU budget (error 10021 — the ceiling is **1 second**).
Three things keep this working and each breaks silently:

- The Hono app, oRPC handlers and cron/queue handlers live in `./worker-app`
  and are reached through `import("./worker-app")`. **Never add a static import
  of `./rpc/**` or `./workflows/**` to `index.ts`** — it re-eagers the whole
  graph.
- Durable Objects must be real exported classes, so they stay eager. Workflows
  are lazy shims that dynamically import their implementation when `run()`
  fires.
- Runtime types come only from the generated `worker-configuration.d.ts`.
  Do not add `@cloudflare/workers-types` to this program (a dependency, a
  `types` entry, or a triple-slash in a package it imports): a second copy of
  the runtime globals splits `Cloudflare.Env` / `CloudflareEnv` resolution by
  program order (TS2740 in `kernel-voice-do.ts`).

## The first-request floor

There are **two** evaluation budgets, and the entrypoint contract above only
buys you the first. Deferring `./worker-app` does not remove its cost — it moves
it to the first request into _every isolate_, and under load concurrent requests
land on fresh isolates and each pays it again. Without per-namespace laziness
most of that cost is evaluating `@tedix/api-contract` schemas and contracts for
the namespaces a request does not touch.

So the router graph is lazy **per namespace**: every entry in
`src/rpc/routers/index.ts` is wrapped in `lazyRouter()`, and a request unlazies
only the branch it routes into (`/openapi.json` and `/v1/*` still see the whole
tree — the generator unlazies everything). Consequences:

- **Never static-import a router into `worker-app.ts` or anything it reaches at
  module scope.** One such import re-eagers the whole contract graph. Route
  handlers whose implementation touches a router must `await import(...)`
  inside the handler.
- `routers` is for oRPC handlers and generators **only**. Its values are `Lazy`
  at runtime, so `routers.billing.getPlan` is `undefined` despite typechecking.
  Import the router module directly, as `createRouterClient` call sites do.

Keep the floor honest, but do not mistake it for the latency budget: a warm
authenticated request spends little CPU and most of its wall time in serialized
round trips to the D1 primary. Measure cold-start evaluation separately from
warm request latency.

`apps/api/scripts/check-lazy-imports.ts` follows static imports from the real
entrypoints and rejects eagerly reachable router implementations.
`rpc/routers/lazy-namespace-isolation.test.ts` guards namespace loading behavior.
There are no bundle-byte or router-line ceilings.

## Contract-first, always

<!-- codex:rule slug=api-contract-first level=MUST owner=api state=advisory -->

Every procedure comes from `implement(contract)` — there are no `os.input()`
procedures and no `publicProcedure`/`internalProcedure`/`mcpProcedure`
builders. Contracts live in `packages/api-contract/src/contracts/`, never
inline in a router.

Three registries must agree and `rpc/routers/contract-parity.test.ts` enforces
it: `apiRouter` (the complete RPC implementation tree), `apiContract` (what
typed clients see), and `ROUTERS` in
`packages/api-contract/src/utils/contract-routers.ts` (what contract-endpoint
resolution and the MCP tool-schema projection see). Adding a router to only one
of the three ships an endpoint that is live but invisible to clients — that has
regressed before.

The public REST/OpenAPI surface is a strict operation-level subset. Procedures
opt in with the `REST` metadata tag; `rpc/public-rest-operations.ts` owns the
review inventory and rationales, and the spec test proves exact equality. New
procedures remain RPC-only by default; `internal` is an additional deny rule.

## Error codes

Every value in `ErrorCodes` (`rpc/orpc.ts`) **must** be a code oRPC
recognises. oRPC resolves status as
`status ?? COMMON_ORPC_ERROR_DEFS[code] ?? 500`, so an invented code silently
becomes a 500 no matter what a contract's `.errors()` map declares — and the
declared/actual mismatch also makes `isDefinedError()` return false for it.
`rpc/orpc.test.ts` pins this. Note oRPC v2's `ORPCError` carries **no
`status`** field; classify by code (`CLIENT_ERROR_CODES`).

## Authorization is two planes

Not one. `withPermission` enforces Descope RBAC and deliberately waves through
`apikey`/`m2m`/`tedi`/`service-binding`; `createScopeMiddleware` enforces
scopes and deliberately waves through `user`/`service*`. **Neither
short-circuit is a bug — do not "fix" them.**

The real hazard is a procedure carrying only one plane: it is then unguarded
for the other principal class. A procedure reachable by API key with no scope
guard gives that key full access regardless of its declared scopes. Some
routers legitimately hand-roll authz in handler bodies instead (e.g.
`work-items.ts`) — that is fine, but it must be deliberate.

Use `withAuthorization(permission, scope)` for the ordinary two-plane case. It
is semantically the same as chaining `withPermission` and
`createScopeMiddleware`, but keeps one middleware closure per procedure for the
Worker bundle and cold-start floor. Keep the individual guards only when a
principal-shaped handler genuinely needs them separately.

An irreversible machine workflow may instead use
`withExactApiKeyScope(scope)`. This stronger boundary rejects users, service
bindings, M2M and tedi principals, as well as wildcard/platform keys, so the
human RBAC plane is absent by construction. Use it only with an operation-owned
key scope and a second persisted claim/ownership fence; the authz lint treats
that exact primitive as covering both principal classes.

`bun run lint:authz` measures this and `lint:repo` enforces it. The current
counts and RBAC-only/scope-only/no-plane split come from
`bun run lint:authz --report`; do not copy those drifting totals into docs. There is
no baseline: any gap fails. The report groups gaps
by router with the exact guard each procedure is missing. Deliberate
handler-body authz goes in `HAND_ROLLED_AUTHZ`, and the lint rejects an entry
whose file shows no principal branching plus scope inspection, so the exemption
cannot rot. A procedure whose machine plane is ordinary but whose human plane
is identity-, resource-, or role-bound inside the handler is narrower: use
`withAuthorization({ handlerOwnedUserAuthorization: "specific rationale" },
scope)`. The non-empty rationale is part of the typed guard declaration;
`null`, `[]`, and `{ anyOf: [] }` are invalid. The lint recognizes only that
named shape and cannot exempt an ordinary one-plane procedure.

Use `requireOrgId` / `requireOrgIdOrInput` from `rpc/org-scope.ts` for
organization scope. Do not add a local copy. A missing organization is
FORBIDDEN, never 401: a 401 bounces a user with a valid session to `/login`.

Tenant ownership belongs in the query predicate for caller-supplied record ids;
use organization-scoped query helpers such as `getAppByIdForOrganization` and
`getTediByIdForOrganization`. `requireOrgId(context)` alone proves only that
the caller has a tenant, not that the requested row belongs to it. There is
no baseline: any unscoped read fails.
Truly global resolvers need a call-specific rationale in
`NON_TENANT_BY_CONSTRUCTION`; trusted cross-tenant service/platform handlers
need an exact, stale-checked `REVIEWED_NON_TENANT_HANDLERS` disposition.

## Logging

`logProcedureCall` is registered once as a handler client interceptor in
`worker-app.ts` and covers every procedure. Do not add per-procedure logging
middleware; ordering there meant some routers never logged permission denials.

## D1

Follow `packages/db/AGENTS.md`. Two rules that have each shipped defects: **never `db.transaction()`** (D1 refuses `BEGIN`,
error 7500 — `db.batch()` is the transaction primitive), and **no two selected
columns may share an output name**. Direct RC.4 selects use array-mode rows,
but D1 batch results use object rows, collapse duplicate keys, and are then
mapped positionally — use `prefixedColumns()`. Test with `createD1Facade()`,
which rejects both. Bound
parameters cap at 100 per query; chunk ≤50.

Shared-D1 statement construction belongs in
`packages/db/src/queries/<domain>[/<capability>].ts`, including statements
called by jobs, services, workflows, kernel modules, and `worker-app.ts`. API
code imports the exact owning `@tedix/db/queries/<domain>[/<capability>]` path
directly; it does not import a query barrel, Drizzle operators/tables to build
inline statements, or call
`D1Database.prepare()` unless the exact storage-owner exception is approved in
`scripts/db-access-exceptions.json`. `bun run lint:db-access` checks this ownership boundary.

## Verification

Narrowest proof that covers the risk:

```bash
cd apps/api && bunx tsc --noEmit        # 0 errors expected
cd apps/api && bun run test:run         # full suite
bun run lint:repo                       # boundaries, exports, tsconfig, wrangler, planes
bunx vp check <files you touched>
```

Do **not** use `bun test` here — it ignores the Vitest/Workers aliases.

A passing source check is not deployment proof. For authorized deployments,
read the exact target's live revision and verify the changed behavior.
