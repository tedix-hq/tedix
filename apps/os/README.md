# @tedix/os

The Tedix OS web application: where people see and steer the work their team
and its AI assistants share.

In plain words, it opens on two views. The **Deck** shows the decisions
waiting for you, one card at a time, and ends when you are done. The **Feed**
is a timeline of everything that happened, each entry with its record. Around
them sit Workspaces for shared documents, sheets and presentations, and
settings for who may do what. It works on a phone and on a desktop.

To run it with sample data and no account, use `bun run --cwd apps/os dev`
(UI only) or `bun run-local --demo` from the repository root (full local
stack). [Development](#development) has the details.

## Overview

Tedix OS is the main working interface for durable company work. The entry
route opens Work, where Feed and Deck are the primary views; Projects is
available through More views. Workspaces, Documents, Team, Skills, Apps and
Memory share the authenticated shell. Templates and Activity log are available
through Settings, alongside organization and personal settings:
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

Fixture mode serves a fictional sample company ("PricePilot") from
`dev/demo-pack/`: Feed, a Deck of 36 pending cards with decided history, tedis,
workspaces and memory facts. Dates are shifted onto today when the server
starts, and a pack older than a week is rebuilt. The shell shows a **Sample
data** badge, and sending or scheduling is refused with a clear message
(`@tedix/api-contract/utils/demo-sending-gate`). `bun run-local --demo` seeds
the same pack into local D1 and sets `TEDIX_DEMO_SENDING_OFF` on the API. Set
`TEDIX_OS_FIXTURE_PACK=classic` to get the original fixtures back.

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
- **Server data:** TanStack Query over oRPC. Contract-backed reads and cache
  writers share one generated `osQuery` namespace per domain through
  `src/lib/os-query-options.ts`; `scripts/lint-os.ts` rejects handwritten
  query-key literals. D1/API remains canonical; Query is a browser cache and
  live projections reconcile by invalidating or replacing generated keys.
- **UI:** Cloudflare Kumo behind app-local `src/components/kumo/*` adapters,
  including shared `Page`, `PageHeader`, and `PageActions` composition.
- **Live editing:** the operational-transformation (OT) `CollabRoom` and browser-only editors are explicitly
  owned, disposed on navigation, and committed through canonical revision
  contracts.

Tedix OS intentionally does not use TanStack Start today. It is an authenticated,
editor-heavy workspace whose useful state begins after session establishment.

## Architecture

See the public [Cloudflare architecture](../../docs/public/cloudflare-architecture.md)
for the API, runtime, storage, and frontend boundaries.

## Deck decisions

The Deck accepts critical approvals, opportunities, owned strategy choices and
near deadlines. Routine filing, delegation and tool writes remain in Feed.
The versioned `deck-routing.v1.json` asset supplies the rules; a Deck gadget's
`config.routing` can override them. Routing receipts use the existing personal
learning ledger. Repeated negative usefulness signals can move a valuable
class back to Feed; critical boundaries remain visible.

To operate from workspace chat, ask: "Refresh my deadline decisions and show
the source task and draft before I decide." Discover `refresh_decision_sources`
(`workInteractions.refreshDecisionSources`, `mcp:messaging.write`); it accepts
only the authenticated person and scans their owned unfinished Work. The Deck
refreshes this source when opened and every two minutes. A date produces one
card per task. Personal-agent findings marked `proposal` produce an owner card;
FYIs stay in Feed. Factory sheets must declare a valuable Type, such as
`opportunity` or `relationship.followup`, to enter the Deck.

A follow-up card's `create_owner_task` choice creates a proposed task assigned
to the person who answered. The draft and source stay on that task; sending
remains that person's next step. Source creation, a saved answer, task creation
and an external send are separate outcomes.

## Card feedback

Select draft text to add quote-anchored comments, or press `C` for whole-card
feedback. Three wording chips and one free line form a batch; sending the
batch requests a rewrite from the card's owner and leaves the decision open.
Review the agent's summary and inline diff, use **Keep original** per paragraph,
and open **Versions** in **Why this** to compare or restore versions. Restore
appends a version. Approval and sending remain separate actions.

**Always do it this way** saves a personal wording rule. **Not true** removes
that rule from future writing context; **Keep** confirms it. Style preferences
cannot change facts, recipients, dates, amounts, consent or authorization.

From workspace chat, ask "Make this card shorter, keep the dates, and show the
versions before I decide." Discover `request_card_changes`
(`workInteractions.requestCardChanges`, messaging write scope) and
`list_card_versions` (`workInteractions.listCardVersions`, messaging read scope).
The former accepts one instruction with optional chips and quote anchors; the
latter returns saved versions, the agent's summary, a plain-text unified diff
and unresolved comments. The addressed person owns feedback and personal
rules; only the producing agent can submit its rewrite with the matching
response id. No tool approval implies an external send.

The fixture browser check is `bun browser-tests/card-revisions.spec.ts` with
`CARD_REVISIONS_TEST_ORIGIN` pointing to the fixture server. It exercises the
selection batch, partial keep, comparison, restore, personal rule controls,
secret-card boundary and pending approval hold at 1280/390 in light/dark.
