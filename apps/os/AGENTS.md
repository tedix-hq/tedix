---
summary: "apps/os scoped rules: one key namespace per domain, the Cap'n Web lane's hibernation constraint, the hand-written Worker, and the app-local Kumo boundary"
read_when:
  - Touching anything under apps/os/
  - Adding a useQuery/useMutation, or any invalidateQueries/setQueryData call
  - Changing the /capn, /collab, or session-broker paths in src/worker.ts
  - Adding or changing a WebMCP tool module (src/components/*-webmcp-tools.ts)
  - Proposing a framework change (TanStack Start, Remix 3, TanStack DB)
title: "apps/os agent guide"
---

# apps/os Agent Guide

Root rules live in `/AGENTS.md`. This file owns only what is specific to Tedix
OS — the constraints that are load-bearing, silent when broken, and expensive to
rediscover.

Start with `apps/os/README.md` for the product and development loop,
`src/worker.ts` for routing, and `src/components/kumo/` for UI adapters.

`apps/os` is a **client-rendered Vite + React SPA** on TanStack Router (file
routes, `autoCodeSplitting`) and TanStack Query, served by a hand-written
Cloudflare Worker at `src/worker.ts`. It is not a framework app and deliberately
so. Change that only for a measured need; the current boundaries are below.

## One key namespace per domain

This is the rule that breaks silently.

Server reads cache under **contract-derived** keys from `osQuery` (the
`createTanstackQueryUtils` client in `src/lib/os-query-options.ts`), which encode
endpoint identity plus the complete validated input. The legacy alternative is a
hand-written array literal like `["os-outputs", workspaceId]`.

React Query matching is **prefix-based**, so those namespaces are **disjoint**. A
generated partial key such as `osQueryKeys.outputs()` can never reach a
hand-written literal, and a literal can never reach a generated key. The moment a
domain's _writer_ (realtime, a mutation's `onSuccess`) lives in one namespace and
one of its _readers_ lives in the other, that reader renders stale data forever:
no error, no retry, no refetch, nothing in a log.

Example: an open canvas document kept rendering the revision it loaded with.

**Corollary — a domain moves whole or not at all.** Migrating one reader of a
domain while its writer stays hand-written _creates_ the defect. If you cannot
move every reader and every writer in one commit, move none of them.

Enforcement is in two halves, and neither subsumes the other:

- **Static:** `scripts/lint-os.ts` (runs in `lint:repo`) fails any new
  inline `queryKey` literal, including positional `setQueryData` keys and
  literals hidden in a ternary. The former exceptions are fully migrated;
  the rule directly rejects handwritten keys without an allowance ledger.
- **Runtime:** `src/lib/realtime-projections.test.ts` proves no realtime domain
  is split.

Known gap, deliberately shipped: the static rule matches key-shaped identifiers,
so an aliased key (`const k = ["os-thing", id]; useQuery({ queryKey: k })`) is
not flagged.

**Exact-key writers are why some domains cannot move yet.**
`src/lib/realtime-projections.ts` patches with `setQueryData` by exact key, and
`src/lib/live-workspace-projection.ts:119` invalidates with `exact: true`. Those
writers must move in the same commit as their readers.

## The Cap'n Web lane must terminate in the stateless Worker

`/capn` is the default browser transport for OS Chat. It is mounted from
`src/worker.ts` and **touches no Durable Object** — that is a correctness
constraint, not an accident:

**capnweb cannot survive Durable Object WebSocket hibernation.** Its
`newWorkersWebSocketRpcResponse` calls `server.accept()` (the non-hibernatable
path, never `ctx.acceptWebSocket`), hibernation resets exactly the in-memory
import/export tables a session depends on, and upstream issue #36 is still open.
Cloudflare's own recommended topology is browser ↔ Cap'n Web ↔ **stateless
Worker** ↔ native Workers RPC ↔ DO.

So do **not** fold the Cap'n Web session onto the `/collab` socket.
`src/collab/room.ts` uses the hibernation API properly (`state.acceptWebSocket`
plus `webSocketMessage`/`Close`/`Error` and `serializeAttachment`); the lone
`server.accept()` there is the room-full branch, accepting outside the
hibernation set purely to deliver a close code. Two lanes is the correct
architecture, not legacy.

Other properties worth preserving:

- **Authorization is re-derived per call.** `SessionCore` re-issues `callRpc` to
  apps/api with the caller's forwarded credentials plus the host-asserted tenant.
  A long-lived stub is not ambient authority here.
- **Cookie-only credentials.** `Authorization` is deliberately not forwarded —
  a bearer would let a caller open a session on any tenant's hostname and run it
  in their own org. The one exception is the zero-account local-demo lane
  (loopback + demo project + `TEDIX_LOCAL_DEMO_ENABLED`), where `worker.ts`
  injects the deterministic local bearer and `mountCapnChat({ localDemo })`
  forwards it — there is no tenant whose host-binding a bearer could invert.
- **There is no fallback transport.** A second (SSE) lane would ship the
  identical `RuntimeStreamEvent` payload into the identical projections sink
  over a second reconnect machine. When
  `/capn` cannot establish — a WS-blocking middlebox, a server regression, a
  dev origin with no `/capn` — the connection manager flips
  `RealtimeStatusSnapshot.degraded` after `REALTIME_DEGRADED_AFTER_FAILURES`
  consecutive failures: the shell chip reads "Live updates paused" and
  ChatThread accelerates its run-set polling and arms transcript polling off
  that flag. A slower server run-set reconciliation remains active while a
  run is live because child settlement can change delegation state without a
  parent-run frame. The machine keeps retrying on its 30s-ceiling ladder and
  the next successful open clears the signal. Established-conversation
  mutations use their Cap'n capability exclusively; a disconnected lane is
  surfaced as unavailable instead of silently retrying through oRPC. The
  synthetic new-thread send remains an explicit control-plane bootstrap because
  no conversation id exists to bind yet. Do not reintroduce a second event or
  mutation pipeline.
- **Known limitation (run-scoped delivery).** The Cap'n pump follows one run at
  a time via `nextRunId` (`session-root.ts`), so durable events written with no
  `runId` (e.g. `conversation.updated` from rename/delete/pin) never reach the
  browser stream, and concurrent runs in one conversation are serialized until
  rollover. The active-run reconciliation backstop repairs server run-set
  state, but nothing consumes no-run conversation frames live today
  (`realtime-projections.ts` does not patch on `conversation.updated`); if a
  consumer ever needs them, add a conversation-scoped verb to the contract
  rather than resurrecting SSE.

## Capability lifecycle is a document singleton

`SessionBoundary` composes two independent things, and the second is the one
that gets overlooked:

```
SessionBoundary
  └─ OsCapabilityLifecycleBoundary   <- singleton owner
       └─ BrokerSessionBoundary      <- resume / renewal
```

`OsCapabilityLifecycleBoundary`'s unmount calls `disposeOsCapabilities()`, which
resets **module-level** singletons — `resetRealtimePumps`,
`resetLiveWorkspaceSubscribers`, `resetRealtimeConnections`. Two mounted instances are therefore not independent:
the first to unmount resets the shared realtime connection manager out from under
the second, and every surface still holding a lease goes quiet with no error and
no reconnect.

**Exactly one capability-lifecycle mount per document.** Today that is
`routes/_session.tsx` and `routes/_cli-session.tsx` — two layout routes, never
both live at once. A new tree (a promoted account/launcher surface, a second
shell) must re-parent under the existing boundary or hoist it above both trees;
it must never instantiate a second. If you hoist it, preserve the local-lane
short-circuit: `resolveOsTenant(hostname).kind === "local"` gets ONLY the
capability boundary and deliberately no broker boundary.

A single-boundary test proves nothing here — every existing test mounts one. The
test that catches it mounts two trees together, unmounts one, and asserts the
other's stream survives (`realtimeSubscriptionCount()` unchanged).

Related: `installOsCapabilityPageLifecycle` deliberately ignores a **persisted**
`pagehide`, because that is a bfcache freeze rather than logout and the tree must
keep its leases to resume on `pageshow`. Any new visibility handling must not
dispose on a persisted event.

## WebMCP tool modules

`src/components/*-webmcp-tools.ts` register browser-agent tools via
`useWebMcpTools` (`src/lib/webmcp/`). Read those modules and their tests.
The rules that break silently are these:

- **No module-scope value imports of `@/lib/api`, `@/router`, or
  `@/lib/os-query-options`.** Defer to execute-time memoized dynamic imports.
  `api.ts` reads `window.location` at module scope and `@/router` drags in
  the route tree — either one breaks node-env suites that import the host
  components, with no error at the import site. `vi.mock` intercepts dynamic
  imports, so tests lose nothing.
- **The one-key-namespace rule above applies to tool writes.** Reads call
  `osApi` directly with no cache writes; a mutating tool invalidates only
  through generated query keys/options — a hand-written key literal in a tool
  module is the same silently-split-domain defect.
- **`execute()` never throws.** Failures return `isError` results; an
  escaping exception is a defect, not error handling.
- **Safety annotations are mandatory.** Reads set `readOnlyHint: true`; writes
  set it false. Reads returning tenant-, user-, or agent-authored content set
  `untrustedContentHint: true`. Hints never replace API authorization.
- **Human decisions stay human.** No accept/decide/approve/settle tools:
  creation lands `proposed`, approvals are surfaced read-only. Do not add a
  deciding tool to an agent scope.

## The Worker is hand-written and stays that way

`src/worker.ts` owns tenant resolution, the fail-closed provisioning
gate, the `/collab` WebSocket 101 into `CollabRoom`, the Cap'n Web mount, an
SSE-streaming API proxy, two session brokers, and the widget MCP bridge. It is
tested in workerd (`bun run test:workerd`).

Every response carries `X-Robots-Tag: noindex, nofollow, noarchive` and
`Cache-Control: private, no-store`. That is what makes SSR worthless here: if a
route ever needs to render for an unauthenticated third-party fetcher, that
header block is the thing that changes first.

`cloudflare.config.ts` owns bindings, routes, assets and the `CollabRoom`
export. `src/worker.ts` hand-declares `OsRouterEnv`, so the app generates no
Worker types.

## UI: app-local Kumo adapters

Import product controls from `@/components/kumo/*`, never raw
`div`/Tailwind replacements and never another app's adapter directory.
Cross-importing is a boundary violation.

Before adding an adapter or guessing at a Kumo API, read the package rather
than the docs site — `@cloudflare/kumo` ships its own machine-readable
reference:

| Need                                            | Source                                        |
| ----------------------------------------------- | --------------------------------------------- |
| Every component's props, variants, and examples | `@cloudflare/kumo/ai/component-registry.json` |
| Conventions and the semantic token contract     | `bunx @cloudflare/kumo ai`                    |
| What exists at all, by category                 | `bunx @cloudflare/kumo ls` / `doc <Name>`     |
| Copy-in layout blocks                           | `bunx @cloudflare/kumo blocks`                |

Kumo also ships ~40 Base UI primitives under
`@cloudflare/kumo/primitives/*` (`scroll-area`, `drawer`, `toggle-group`,
`navigation-menu`, `context-menu`, `number-field`, `otp-field`, `form`,
`csp-provider`, …). They are the right layer when a product control needs
behavior Kumo's styled components do not expose — check there before building
interaction logic by hand.

The bridge in `packages/design-tokens/src/kumo.css` is a name-matched contract
with no compile-time check: a token Kumo renames silently stops being projected
and the component keeps Cloudflare's default. `bun run lint:kumo`
enforces both directions on every push (inside `lint:repo`); `bunx @cloudflare/kumo migrate` reports the renames Kumo
declares for itself.

## Validation and deployment

`test:ci` runs browser and workerd suites; `build` performs a production Vite
build of the SPA and the Worker (`build:local` builds the isolated `bun dev`
lane). The pre-push hook selects relevant tests and type checks.

Managed deployment runs through the guarded workflow in `tedix-hq/tedix-cloud-ops`,
not an app-local deploy command. OS owns the SQLite `CollabRoom`
export: keep it declared with the same storage, since a changed storage is
rejected and a removed or renamed export drops every room. Verify this Worker's live revision and
behavior; another surface's health check is not OS deployment proof.

Current OS conventions: one generated `osQuery` namespace per domain,
loader-prefetched first-paint data, validated URL state, exact-key mutation
reconciliation, lazy route chunks, and OS-owned canonical links.

## Gates

`bun run test:run` runs Vitest and the workerd suite. `bun run build` builds
once and reports Vite's normal output sizes. No bundle-size ceiling blocks work;
keep lazy routes and investigate actual loading regressions.

## Before proposing a framework change

Do not change frontend frameworks merely to follow a release announcement.
Use a measured product need and preserve routing, session, query and UI ownership.
