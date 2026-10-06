---
summary: "Tedix OS product contract: the multi-tenant apps/os application, its routes, per-organization origins, state ownership, the os MCP tool projection, and WebMCP layers"
read_when:
  - Changing the main Tedix working interface or its navigation
  - Integrating Work Items, workflows, tedis, MCP apps, widgets, artifacts, brain, or audit into Tedix OS
  - Deciding whether behavior belongs in Tedix OS or in an existing Tedix owner
  - Adding an OS operation that humans and agents must both reach
title: "Tedix OS"
---

# Tedix OS

Tedix OS is the main working interface for Tedix: one authenticated origin that
combines the governed Tedix control plane with a programmable workspace. It is
the first-party application in `apps/os`, deployed as a single multi-tenant
Worker that serves every provisioned organization at `https://{slug}.os.tedix.dev`
and a central launcher at `https://os.tedix.dev`.

The terminal counterpart is the Tedix CLI (`packages/cli`). Both reach the same
contracts; `apps/os` is the only administrative and working product frontend.

## Invariants

- Tedix OS is a composition layer. It never becomes a second source of truth
  for durable Tedix state; `apps/api` and D1 own committed records.
- Every meaningful OS operation is an `osWorkspaces` oRPC contract verb that is
  also projected as an `os` MCP tool. A verb reachable only from the browser is
  a defect.
- A hostname is routing context, never authority. The API verifies caller,
  membership, tenant, and permission on every request.
- Live collaboration state (`CollabRoom`) is disposable. A revision becomes
  durable only through an explicit, compare-and-swap Commit to D1.
- Notifications, open sockets, and Query invalidation are hints. Canonical API
  reads decide rendered state.
- Untrusted content (Gadget previews, MCP Apps, widgets) renders only in
  explicit sandbox hosts; first-party routes never use an iframe.

## Surfaces

All surfaces are generated file routes in one responsive shell
(`apps/os/src/routes/`, `apps/os/src/routeTree.gen.ts`).

| Route               | Surface           | Job                                                                                              |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `/`                 | Activity          | Work Items, runs, approvals, and results; per-run detail at `/activity/runs/{runId}`             |
| `/chat`             | Chat              | The Home/kernel conversation surface                                                             |
| `/workspaces`       | Workspaces        | Search, create, and reopen Workspaces; start from a Blueprint                                    |
| `/workspace/{uuid}` | Workspace         | One Workspace's chat-and-workpiece workbench, with live co-editing through `CollabRoom`          |
| `/blueprints`       | Blueprints        | Reusable workspace templates: publish, inspect, export, instantiate                              |
| `/outputs`          | Outputs           | Documents, sheets, and presentations with editors and PDF/PNG export                             |
| `/team`             | Team              | Tedis, delegation, and permissions                                                               |
| `/skills`           | Skills            | Instruction skills, executable skills, triggers, and workflows                                   |
| `/apps`             | Apps              | Installed MCP apps with a live widget bridge; widget resources load through `MCP_SERVICE`        |
| `/brain`            | Brain             | Bounded memory and rationale views                                                               |
| `/compute`          | Usage and budgets | Runtime spend, budget, model routing, and credential health, each labeled with its data source   |
| `/audit`            | Audit             | Read-only trace and audit projection                                                             |
| `/sites`            | Sites             | Owned Emdash CMS sites and documentation deployments                                             |
| `/install`          | Install Tedix     | CLI and coding-agent setup with host-specific install, sign-in, and verification steps           |
| `/account/profile`  | Personal profile  | Tenant-neutral display name and avatar; email and login security stay with the identity provider |
| `/account/settings` | Personal settings | Per-organization presentation preferences                                                        |
| `/admin`            | Admin             | Organization settings: profile, identity, connections, API keys, billing, paid-tool budgets      |

The same application renders **Tedix Identity** on `os.tedix.dev`: login,
signup, invitation acceptance, first-organization setup, organization
selection, CLI authorization, and inbound-app consent. Shared journey UI does
not mean shared credentials; OS, CLI, CMS, inbound clients, and provider
connections each keep their own session or OAuth grant. Browser refresh-token
rotation belongs to the separate `apps/session-broker` Worker.

## Frontend architecture

Tedix OS uses TanStack Router and TanStack Query as a client-rendered SPA, not
TanStack Start. `apps/os/src/main.tsx` mounts the React tree; the OS Worker
(`apps/os/src/worker.ts`) owns hostname resolution, sessions, API/MCP/
collaboration proxying, and the SPA fallback. The workspace depends on
browser-only editors, a collaborative edit stream, and live presence, so server
rendering buys little. Revisit this only for a concrete need for server-rendered
OS content or server-side Query hydration.

| Concern            | Rule                                                                                                                                                                                                                                   | Source                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Route ownership    | Generated file routes only; no central route registry. Automatic route splitting stays on.                                                                                                                                             | `apps/os/vite.config.ts`, `src/routeTree.gen.ts`                                           |
| Layouts            | Auth, session, chrome-free, and tenant shells are nested or pathless routes with `<Outlet />`; the root shell never branches on `window.location.pathname`.                                                                            | `src/routes/_auth.tsx`, `src/routes/_session.tsx`, `src/routes/_session/_tenant.tsx`       |
| URL state          | Stable identity lives in typed params; bounded presentation selection lives in validated search. The open workpiece tab set is the `workpieces` search param (deduplicated, at most 6, invalid entries dropped individually).          | `src/lib/canvas-search.ts`, `src/routes/_session/_chrome-free/workspace_.$workspaceId.tsx` |
| First-paint data   | Route loaders validate params and prefetch critical reads with the router `QueryClient`; `loaderDeps` for search-driven reads.                                                                                                         | `src/lib/os-route-loaders.ts`                                                              |
| Query identity     | Contract-backed requests use generated oRPC keys and options. Handwritten keys are only for documented local projections.                                                                                                              | `src/lib/os-query-options.ts`                                                              |
| Live data          | Query is a projection. A live event may replace a complete cache shape or invalidate its exact key; reconnect refetches canonical state. While a Home run is active, Chat also reconciles the run set on a timer.                      | `src/lib/live-workspace-projection.ts`, `src/lib/realtime-projections.ts`                  |
| Collaborative room | A `CollabRoom` holds one OT base plus the ordered change stream, stamped with the canonical revision it is grounded on. Commit is a compare-and-swap against that stamp; an edited room is never silently moved onto a newer revision. | `src/collab/room.ts`, `src/collab/ot/authority.ts`                                         |
| Resource lifecycle | Every socket, capability stub, listener, timer, and editor binding has one owner and explicit cleanup on unmount, tenant/workspace switch, logout, and error.                                                                          | `src/lib/use-live-workspace.ts`                                                            |
| Route states       | Router defaults own pending, error-with-retry, and not-found; override only for geometry-specific skeletons.                                                                                                                           | `src/router.tsx`, `src/components/os-route-boundaries.tsx`                                 |
| UI composition     | Controls and page primitives come from `@/components/kumo/*`. Standard routes compose `Page`, `PageHeader`, `PageActions`.                                                                                                             | `src/components/kumo/page.tsx`                                                             |

Cross-surface visual rules live in [the design system](design.md).

### Chat projection

OS Chat is a Home/kernel surface. A turn goes to the organization's kernel, and
the transcript renders the rows the kernel persists on the parent run
(`message.delta`, `message.reasoning`, `message.phase`) read back through the
kernel event stream. The embedded Tedi widget is the one chat surface that runs
on the tedi runtime instead; see [agent runtime](../tedi/agent-runtime.md).

Both surfaces share the Cap'n Web session, turn-stream, and projection
convergence primitives in `packages/chat-transport`:

| Property           | Guarantee                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Startup race       | A supplied hint subscription is installed before the initial read; a hint racing an in-flight read triggers a follow-up read.           |
| Delivery watermark | The local revision advances only after the consumer accepts delivery. A failed read or callback retries on the next tick.               |
| Authority          | Notifications are hints; API reads decide rendered state. A healthy socket is not proof of freshness.                                   |
| Cadence            | Mutable projections reconcile every 15 s by default, and run sets and approvals every 60 s while idle; degraded realtime shortens this. |

Not guaranteed: there is no conversation-scoped subscription for changes that
carry no run id, so timer reads are a correctness backstop, not an optimization.

Voice dictation in OS Chat and the widget uses one headless controller
(`packages/chat-transport/src/voice-composer.ts`). A transcript is inserted into
the composer for review and sent only as an ordinary text turn; no audio artifact
is stored. Client lifecycle events carry no audio, text, credentials, or device
ids. Permission, device, connection, and timeout failures leave the composer
recoverable with a retry action.

### Conversation lifecycle

Archiving a Home conversation is reversible and keeps the transcript. Permanent
deletion (`kernelRuntime.deleteConversation`) first cancels every active run in
the conversation through the parent/child cancellation cascade, then purges the
conversation-owned kernel events, runs, submissions, grants, pending approval
mirrors, wake state, and trace bundles in one D1 batch. A content-free tombstone
prevents late events from resurrecting it, and a content-free audit receipt
records the action. The organization's main Home thread cannot be deleted.

Accepted Work Items and child-tedi ledgers survive deletion because they are
independently owned. Not guaranteed: content-addressed attachment blobs in R2
are not erased, since another reference may share them.

The embedded widget exposes deletion only when its host supplies an
`options.deleteConversation` provider backed by the API
(`Tedix.deleteConversation(conversationId)`); otherwise deletion fails
explicitly rather than removing only local state.

## Origins, sign-in, and sessions

Every organization has exactly one origin, `https://{slug}.os.tedix.dev`.
Because the tenant is fixed by the origin, one person can keep several
organizations open in separate tabs without global tenant state.

**Launcher.** `os.tedix.dev` is the authenticated central launcher served by the
same Worker. `directory.listMyWorkspaces` lists each active membership with
server-built entry points for its OS, MCP, and CMS surfaces. Launchers and
switchers always go through broker-start URLs, so a stale cookie from another
signed-in person cannot change identity during an app switch. The launcher
stores no selected tenant and refuses `/api/*`. It also hosts the CLI
organization picker at `/cli/login`, which returns only the selected slug over
a state-bound loopback callback and never relays a tenant token.

**First run.** After sign-up, the launcher calls the idempotent
`organizations.getMyOrganization` bootstrap, which creates or repairs the D1
organization, owner membership, identity-provider tenant, and first personal
tedi. The owner then names the organization and chooses its slug through
`organizations.completeOsOnboarding`. That write first provisions the
organization's unified MCP gateway and its resource registration, and only then
enables `features.os`. A partial attempt stays non-launchable and a retry reuses
what exists.

**Sessions.** An unauthenticated tenant deep link enters the session broker for
that origin. The broker resumes the browser session, selects the hostname's
tenant, and returns a single-use code over a strict callback allowlist. The OS
Worker exchanges it through a Service Binding and writes
`__Host-tedix-os-session`, a host-only, Secure, HttpOnly cookie. Browser code
never sees the JWT. Refresh cookies exist only on the auth host, and product
code never reads or rotates them. Missing, expired, or mismatched product
credentials fail closed to a clean brokered sign-in. The CLI picker uses a
separate `__Host-tedix-cli-session`.

**Proxying.** The Worker translates the product cookie into the identity
provider's session header only on same-origin API, MCP, collaboration, and Cap'n
Web proxy requests. It strips any browser-supplied tenant override and asserts
the hostname's tenant; `apps/api` independently checks membership and rejects a
JWT selected for another organization. A session whose tenant does not match the
hostname is reissued through the broker before the SPA mounts.

**Provisioning.** The wildcard resolves every slug, so the Worker resolves each
hostname through `API_SERVICE` against `organizations.features.os` and returns
404 for unprovisioned slugs before any HTML ships (`apps/os/src/worker.ts`,
`apps/api/src/rpc/routers/os-tenant.ts`). There are no alias origins or custom
domains for OS.

Auth modes and token shapes are in [platform auth](../platform/auth.md).

## State ownership

| Domain                                      | Owner                                                                                                   | Tedix OS responsibility                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Work Items and projects                     | API + D1 ([work items](../cognition/work-items.md))                                                     | Read, filter, steer, and review through contracts                               |
| Kernel and Home runs                        | Tenant kernel and runtime ledger ([kernel execution model](../cognition/kernel-execution-model.md))     | Start or steer work and render run state; never plan in the frontend            |
| Tedis                                       | Tedi control plane and identity                                                                         | Select workers, show health and delegated work, compare configuration revisions |
| MCP gateway and apps                        | `apps/mcp`, app catalog, connection scopes, FGA, policy ([MCP runtime](../mcp/runtime.md))              | Discover and call capabilities through Code Mode or exact grants                |
| MCP widgets                                 | MCP Apps resource contract + `apps/mcp-ui` ([MCP Apps](../mcp/apps.md))                                 | Fetch and sandbox resources; preserve `_meta`, CSP, and approval boundaries     |
| Brain, memory, skills, rationale            | Cognitive stores and APIs ([brain](../cognition/brain.md), [skills](../cognition/skills.md))            | Retrieve bounded context with provenance; write only through APIs               |
| Approvals, grants, audit, cost              | Policy, approval, billing, and event records                                                            | Show consequences; an OS approval never overrides a Tedix denial                |
| OS workspaces, Gadgets, Blueprints, outputs | D1 via `apps/api` (`packages/db/src/schema/os-workspaces.ts`, `packages/db/src/queries/os-workspaces/`) | Render and revise committed revisions                                           |
| Live collaborative state                    | `CollabRoom` Durable Object in `apps/os`                                                                | In-flight OT stream and presence only; never writes D1                          |
| Per-user OS preferences                     | D1 `user_configs` (`packages/db/src/queries/user-configs.ts`, contract `userSettings`)                  | Presentation, regional, accessibility, and notification preferences             |

## Workspaces

A Workspace is an organization-owned work context, not a user account, a tedi,
a runtime, or a folder of copied credentials. Its UUID groups conversations,
Gadgets, outputs, resource references, and links to Work projects.

| Concern       | Contract                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity      | `os_workspaces.id` inside one organization; organization-scoped predicates authorize every operation.                                                                                                                                                                                            |
| Lifecycle     | `create`, `get`, `update`, `archive`, `delete` in `osWorkspaces.workspaces`. The first substantive send from general Chat creates a visible Workspace named from the prompt. Archive is reversible. Delete requires `os:admin`, a prior archive, no retained proposals, and no live share links. |
| Contents      | Home conversations, versioned Gadgets, external resource references, outputs, and links to Work projects. Work Items stay in Work; outputs may outlive the Workspace.                                                                                                                            |
| Navigation    | `/workspace/{uuid}` is stable and shareable within the organization. Favorites and recents are per-user presentation preferences, not permissions.                                                                                                                                               |
| Collaboration | `CollabRoom` keyed `{tenant}:{workspace}:{document}` owns only the OT stream and presence. The origin authorizes the exact Gadget or output before the socket upgrade.                                                                                                                           |
| Capabilities  | Gadget manifests declare requirements. Connections, scopes, grants, approvals, and secrets stay with their owners and are resolved at admission; a Workspace never holds provider credentials.                                                                                                   |
| Execution     | `run_os_gadget` names an organization-owned `tediId` and dispatches the manifest's executable skill through the skill runtime, which owns output, cost, and settlement. `approvalMode: "required"` can only make a run stricter. A pending receipt is pollable as an MCP Task.                   |

### Chat execution and MCP UI

Chat owns intent, the approval card, the answer, and links to run detail. The
kernel owns routing, tedi selection, and approval coordination; the selected
tedi owns tool calls and Code Mode. The kernel is never a second tool runtime.

**Workspace selection from agents.** Native `home.ask` accepts the same typed
`workspaceContext` as OS chat: a Workspace ID and an optional Gadget or Output
workpiece. The API validates every ID in the caller's organization. Use a new
explicit `conversationId`, or a conversation already associated with that
Workspace; a conflicting selection is rejected. Omitting `workspaceContext`
preserves an existing conversation's Workspace, and omitting `conversationId`
retains the caller-scoped default. A shared default conversation is not a fresh
isolated context for validation.

**Direct reads.** An operator may run exactly one catalog tool declared
`readOnlyHint: true`, from the composer's tool picker or as
`/read <appSlug>.<toolName> <JSON arguments>`. The server preflights the
credential scope, the call bypasses Home routing, and the MCP edge still
enforces scopes and credentials. An idempotency key fences retries. Success and
typed failures are persisted in the transcript. Writes, natural-language
requests, and multi-step work stay on the Home/tedi path.

**Delegation holds.** A delegation verdict of `needs_approval` parks the parent
run as `requires_approval`. OS resolves the hold through `respond_home_approval`:
approval resumes that run once; rejection cancels it without creating a child
run. This run-scoped gate is distinct from approval requests raised later by an
already-dispatched child.

**Delegated UI.** When a delegated tedi returns MCP UI, the kernel promotes a
typed `delegatedResult` into the Home message: at most three validated
`ui://widgets/mcp-app/{appSlug}/...` targets, each with an optional bounded,
credential-stripped initial result, so the view survives reload. Invalid
schemes, credentials, and oversized bodies are dropped.

The embedded chat host renders the same json-render and MCP App results through
validated `mcp-ui.tedix.dev` frames. This is visual parity only: the native OS
host keeps the full MCP App bridge for guest tool calls, while embedded frames
receive bounded initial data and no host credential.

### Work pane and Gadgets

The Workspace **Work** pane projects explicitly linked Work projects as
checklist, board, timeline, and dependency views. It is not a second workflow
store, and undated items stay visibly unscheduled rather than faked into a
Gantt chart.

Gadgets are optional custom visualizations and governed workflows. They keep
their own revisions, layout, receipts, and outputs, never copies of Work state.
MCP UI shows one tool result; a Gadget gives a reusable workflow a versioned
manifest, collaboration, resource grants, and receipts. Promoting a result to a
Gadget is an explicit action.

A committed Gadget whose manifest uses `ui://widgets/mcp-app/{appSlug}/...`
opens as a sandboxed **App** through the governed `WidgetFrame` resource proxy;
**Code** shows the collaborative manifest editor. The preview follows the
committed revision, so source edits run only after Commit.

A Gadget revision may declare version-1 custom export descriptors. Each names
one stable format id, label, MIME type, extension, and canonical
`outputs/<step>.json` artifact path; it never carries a URL, credential, or
secret metadata. The Runs view offers those formats only for completed
receipts, and the API resolves the descriptor from the exact revision pinned by
that receipt, verifies the successful artifact's decoded MIME type and size,
then mints a five-minute attachment URL through the untrusted Artifact Gateway.
Executions with missing, malformed, or non-empty resource-access envelopes are
not exportable through this bearer lane: source-derived access cannot be
downgraded into possession of a URL.

### Connections and Workspace resources

"Resource" has two meanings. An MCP `resources/read` URI is protocol content. A
**Workspace resource** is a Tedix reference to one external object, such as a
repository, mailbox, or database. Names must say "workspace resource" for the
latter.

| Layer                 | Meaning                                                                 | Owner                                                       |
| --------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| App                   | A configured MCP tool provider                                          | D1 app/tool metadata and gateway policy                     |
| Connection            | A personal or organization credential grant for an app                  | Connection management and token vault                       |
| Workspace resource    | A named, non-secret reference to one provider object                    | `os_workspace_resources` via `osWorkspaces.resources`       |
| Gadget resource grant | Operations one Gadget revision may request against named resource slots | `manifest.resourceGrants`, rechecked at every run admission |
| Tool invocation       | One operation, argument, acting identity, policy decision, and receipt  | MCP gateway, tedi runtime, policy, and audit                |

**Connect app** opens the gateway catalog and owns consent; **Attach resource**
records one provider object without copying a credential. Removing a resource
does not revoke its connection; revoking a connection makes dependent resources
unusable. Admission requires every granted slot to resolve to an active
reference and rejects a personal connection for a background tedi. The skill
runtime receives a host-overwritten `_tedixContext` with only the organization,
Workspace/Gadget identity, provider object references, and allowed operations —
no tokens, rosters, or budgets.

`os.read_os_workspace_pdf` reads an attached Drive file by Workspace and
resource UUID, never an arbitrary provider file id. It rechecks the reference,
the tedi's app assignment, scope, and credential, returns at most two bounded
page windows plus the provider revision and a SHA-256 of the source bytes, and
persists nothing. A connection badge only confirms that a credential exists.

### Organization context

Organization context is a bounded envelope assembled for one run, not a giant
prompt and not authorization by hostname. Precedence, highest first:

1. platform safety;
2. organization policy and purpose;
3. acting tedi identity, pinned configuration, and `SOUL.md`;
4. Workspace instructions and selected resource references;
5. active conversation;
6. selected Gadget revision;
7. the current user request.

A lower layer can add task detail but cannot grant a capability, change
organization identity, override policy, or select a personal connection for an
unattended tedi. The kernel assembles the envelope; the browser never builds a
competing prompt or context store.

## Sharing and Blueprints

**Share links** are narrow capabilities over one resource, created with
`resourceType` plus `resourceId`. Output links carry `viewer`; Gadget and
Workspace links carry `use` (runnable widgets only) or `build` (also the
manifest, after the recipient's membership and `os:author` are rechecked).
`living` links follow the current revision; `pinned` links hold one. A link
never transfers the owner's credentials, memory, billing identity, or
connections.

Revisions produced by a Gadget run inherit an immutable, secret-free envelope
naming the Workspace resources and connection scopes that contributed to them.
Such links require an authenticated member of the source organization whose
current connections still satisfy every recorded scope; missing provenance or
changed resources fail closed, and living links recheck on every read.

The 256-bit link secret is returned once in a URL fragment; D1 stores only its
SHA-256 hash. Redemption mints a separate short-lived, hash-only session only
if the policy ceiling observed during authorization is still current, and every
session read rechecks expiry, revocation, resource lifecycle, and policy.
Revoking a link revokes its sessions in one batch. Policy ceilings are
monotonic: a write may leave effective authority unchanged or narrow it (for
example `build` to `use`), but cannot clear or widen an existing ceiling. A
tightening revokes every live session in the same D1 batch, so recipients must
redeem again under the narrower authority.

**Blueprint packages.** `blueprints.export` writes one immutable revision as
`{slug}-r{revision}.tedix-blueprint.json`: manifests, output templates, and
typed skill, app, connection, policy, budget, and model requirements. It never
includes credentials, grants, customer data, chat history, memory, or audit
history. Import validates the schema and digest, then creates revision 1 of a
new private draft; an existing name is a typed conflict. Imported lineage stays
unattested.

**Instantiation.** A Blueprint may declare named resource slots with provider,
scope, and cardinality. Preflight separates a missing app connection, a missing
resource selection, and a denied grant. The setup check shown in the UI is
advisory; the instantiate API resolves requirements again immediately before its
D1 batch. Later Blueprint revisions are explicit migrations and never silently
rewrite existing Workspaces.

## Outputs

Outputs are revisioned deliverables, not executable previews. The library
offers search, kind filters, created-by-you/shared scope, and grid or list
layout. Cards show a bounded inert preview and never return HTML, formulas,
image sources, or runnable content. Outputs stay visible when their Workspace
is archived.

Editors by kind:

- documents: paged rich-text editor with headings, formatting, lists, links,
  code, and images;
- sheets: multi-tab workbook with ranges, formula bar, Excel-style functions,
  number formats, sorting, and undo;
- presentations: 16:9 canvas with templates, thumbnails, drag/resize,
  inspectors, speaker notes, and presentation mode.

`OsOutputContent` holds both the rich body (`richText`, `workbook`, `deck`) and
the headless projection (`blocks`, active-sheet `columns`/`rows`, slide
outline). `patch_os_document` updates blocks; `set_os_sheet_range` updates the
workbook and its projection. PDF/PNG export renders the rich body and fetches no
third-party assets. The shared editor frame is
`apps/os/src/components/output-workshop.tsx`; editor bundles are lazy-loaded.

Permanent output or Blueprint deletion requires `os:admin` and a prior archive.
OS browser API calls have a 15-second transport deadline; a failed cold load
shows the typed error and a **Try again** action rather than an endless
skeleton.

### Collaborative editing model

Three concerns stay separate:

- **Live edits.** The `CollabRoom` stream is an ordered sequence of changes
  over one base. It is server-held, not browser-held: there is no offline log,
  and edits that outlive the server's change window are lost on reconnect.
- **Commit.** A draft never overwrites a newer revision. Commit is a
  compare-and-swap; a lost swap blocks the write, says so, and refetches. When a
  room is behind canonical, the panel offers an explicit, warned **Replace with
  revision N**. Invalid or wrong-kind bodies are shown as a typed diagnosis and
  block Commit.
- **Agent proposals.** A proposal is a D1 review record pinned to an immutable
  base. Agents advance preview snapshots by sequence compare-and-swap; previews
  never move the current-revision pointer. A human accepts or rejects; a separate
  merge appends one revision and settles the proposal in one batch, and fails if
  the base moved. Verbs: `list_`, `create_`, `update_..._preview`, `accept_`,
  `reject_`, and `merge_os_collaboration_proposal`.

Presence is weaker than any of these. A socket first passes the Workspace read
check; its JWT is reduced to an opaque tenant-bound key, display name,
participant kind, and coarse role. Raw principal ids, email, and credentials
never reach the room. The roster is memory-only and refilled by periodic client
re-broadcast after a hibernation wake. Presence never authorizes an edit.

### Workbench layout

At the desktop breakpoint the workbench composes the Workspace's conversation
list, the active Home conversation, and the active workpiece. The conversation
browser reuses Chat's switch, new, rename, pin, archive, and delete actions.
Chat creation sends a typed `workspaceContext`, which the API verifies and
stores on the conversation. The composer's capability palette attaches
organization capabilities as context only; it grants no tools, scopes, or
connections.

The newest answer offers **Visualize** (a transient `ui.create_view()` turn),
**Create output**, and **Build gadget**; each only fills the composer. Gadgets
switch between **App**, **Code**, **Connections**, and **Review**; outputs
between their format mode, **Connections**, and **Review**. **Resources** is a
library pane listing inputs, automations, the approved deliverable, and the
latest candidate; recency never marks an output approved. **Focus** gives the
editor the full work area; `Escape` exits. Below the desktop breakpoint the
workbench is single-pane.

## One contract for humans and agents

Every OS operation is defined in `packages/api-contract/src/contracts/os-workspaces.ts`,
served by `apps/api`, and projected through the tenant's unified MCP gateway as
verb-first `os` tools such as `list_os_workspaces`, `create_os_gadget`,
`list_os_output_library`, `patch_os_document`, and `export_os_output`. The
projection map lives in `apps/api/src/services/tool-schema-sync.ts`; do not keep
a parallel list.

The web app calls the same contracts. Mutations keep identity, FGA, policy,
approvals, optimistic concurrency (`expectedRevision` conflicts are typed;
identical replays are idempotent), Work Item linkage, and audit. Two boundaries
are intentional: OAuth consent may require a person in a browser, and untrusted
Gadget output previews render in sandbox hosts.

## WebMCP

A WebMCP-capable browser gets the OS as tools in two layers, both running on the
visitor's own session with `apps/api` and the MCP edge unchanged as the
enforcing layers.

| Layer                  | Role                                                      | Execution path                                                                     |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1: tenant capabilities | Headless access to the whole tenant gateway from any page | Browser → same-origin `/mcp` → tenant unified MCP service binding                  |
| 2: contextual actions  | Small actions for the surface currently on screen         | `modelContext` tool → `osApi` contract → generated Query invalidation or deep link |

- **`/mcp` relay** (`apps/os/src/webmcp/endpoint.ts`): answers lifecycle
  methods locally and forwards `tools/list` and `tools/call` to the tenant's
  unified gateway. The Worker serves the shared `@tedix/webmcp-core` bridge at
  `/_tedix/webmcp/bridge.js`.
- **Route tools** (`apps/os/src/lib/webmcp/`): routes register scoped tools on
  mount and dispose on leave with `useWebMcpTools(scopeKey, build, deps)`. The
  inventory lives in `apps/os/src/components/*-webmcp-tools.ts`.

The layers are not inventory mirrors. When both expose an operation they must
agree on semantics, not on names or counts.

**When a route earns Layer 2 tools.** Only when the surface is a coherent user
intent, a narrow tool is safer or easier to discover than Code Mode, the result
converges with the visible UI through Query keys or a deep link, and the
operation already exists in the API contract. Settings, navigation-only
layouts, and dangerous administration stay Layer 1 only. Do not expose
accept/start/settle, credential, permission, or destructive verbs just because
a button exists.

**One backend, two thin adapters.** Neither layer owns domain behavior. Layer 2
may add a description, bounded inputs, a compact result, deep links, Query
invalidation, and a confirmation step, but never authorization, persistence, or
business validation. Hand-written `WebMcpToolDef` schemas are adapters;
parity tests must fail when they drift from `osApi`. Layer 2 must not call
Layer 1 over `/mcp`.

**Readiness and tabs.** A scope registers only after the tenant and its API
client are ready, or every tool returns a typed retryable
`context_unavailable`. Each document binds its own tenant, so two tabs on
`acme.os.tedix.dev` and `globex.os.tedix.dev` keep separate registries,
sessions, and caches. Tool discovery grants nothing; every call is
re-authorized. Route disposal aborts the previous projection's `AbortSignal`
before the next scope registers.

`window.__tedixWebMcp.status()` reports host detection, desired
registrations, projection generation, and the latest registration error. An
empty tool list with `host.detected: false` means the browser has no WebMCP
host.

Not guaranteed: a successful mutation means the API accepted it; Query
invalidation is only UI convergence. Tool-list notifications are discovery
hints, not authorization or proof of a valid session.

## Embedded provider installations

Tedix can back a host SaaS product's embedded Tedi widget, with one isolated
organization, workspace, and tedi per host business.

- `tedis.provisionProviderInstallation` (platform admin) creates or resumes an
  installation from a `customer` configuration (name, `billingPlanKey`,
  `sponsoredCapacity`) or existing resource ids. Stable keys make retries
  resume partial work; it does not enable Tedix OS or start a runtime.
- `tedis.activateProviderCustomer` lets a provider console user with
  settings-write permission activate a host business by its stable id. The
  provider and its defaults are derived from the caller and from
  `tedis.configureProviderOnboarding`; callers cannot choose them
  (`apps/api/src/rpc/routers/tedis/provider-onboarding.ts`).
- New installations start with assistant access off. **Manage audience**
  sets all or selected host users plus exclusions (exclusions win), keyed by
  the host's stable user ids. `tedis.getEmbeddedProviderAvailability` returns
  only `enabled` for a host user without creating a session. Session exchange
  and every embedded operation recheck the current policy, so disabling access
  stops new turns; an in-flight response may finish.
- Writes require `settings:manage` (people) or `apps:write` (machines) and use
  expected-revision concurrency.

Hosts can also publish a versioned portable Layer 2 profile: the widget SDK's
`context()` call mounts the tools for a stable `routeKey`, and a
`tedix:tool-completed` event lets the host refresh its UI. Version 1 admits only
enabled tools whose catalog classification is `read`, checked again at session
exchange.

Source: `apps/os/src/components/widget-access-settings.tsx`,
`apps/api/src/rpc/routers/tedis/widget-access.ts`,
`packages/api-contract/src/schemas/embedded-widget-access.ts`,
`packages/db/src/queries/provider-installations.ts`.

## Capabilities, connections, and sites

Apps (`/apps`), app discovery (`/explore/apps`), Skills, organization
connections (`/admin/connections`), and personal accounts
(`/account/connections`) share `apps/os/src/components/capability-navigation.tsx`.
They are distinct inventories: skills explain how to do work, apps expose tools,
connections supply credentials.

- **Connections.** Both views use `connections.getConnectionsOverview`.
  Credential state is present, missing, expired, restricted, or unknown. A
  row's on-demand MCP protocol check describes the app service only; it does
  not call a provider tool or validate the credential.
- **Apps.** Installation requires a human review naming organization
  ownership. The overview reports installation, connection, gateway membership,
  governance readiness, and MCP service health as separate facts; its explicit
  service check reports the live `tools/list` count and nothing more.
- **Gateway membership.** `apps.getGatewayMembership` and
  `apps.setGatewayMembership` control whether an installed app appears in the
  unified gateway. Membership is separate from installation and connection and
  never widens client scopes. Disabling keeps the app's prefix and tool
  restrictions for re-enabling, and purges the discovery cache.
- **Skills.** URL-backed **Skills**, **Triggers**, and **Workflows** sections;
  the skill catalog renders optional nested organization folders while keeping
  each skill's SEP-2640 slug and runtime identity stable across moves; sections
  each query their server inventory with server-side search and pagination.
- **Sites.** `sites.list` combines Emdash CMS sites (`cms_sites`) and
  documentation deployments (`docs_sites`). `sites.setLifecycle` archives or
  restores with exact slug confirmation; archive pauses delivery without
  deleting state. `sites.deprovision` permanently erases a site's storage and
  authoring proxy and returns per-resource receipts; failures leave the paused
  record in place. See [Emdash CMS](../emdash/cms.md).

Product nouns:

| Asset      | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| App        | Tools and integrations installed for an organization             |
| Skill      | Reusable instructions and optional executable workflow resources |
| Connection | A personal or organization credential, separate from grants      |
| Automation | A configured trigger or schedule that starts work                |
| Gadget     | An interactive workspace asset with explicit resource bindings   |
| Blueprint  | A versioned template for creating a workspace                    |

There is no plugin manifest or bundle installer, and installation never grants
permissions automatically.

## Account and settings

**Profile.** `/account/profile` derives the user from the verified credential;
callers never submit a user or organization id. D1 `users.name` and
`users.avatar_url` own the Tedix presentation profile; the identity provider
owns email, login, MFA, and sessions. Provider claims fill missing fields but
never overwrite user edits, and Tedix never writes the name or avatar back to the
provider. Not guaranteed: without a provider webhook, an email change can stay
stale until the next bootstrap or sync. Writes use a `profile_revision`
compare-and-swap; avatar uploads use one-time Cloudflare Images URLs bound to
caller, nonce, and starting revision. Superseded images are deleted
best-effort after the D1 write.

**Preferences.** `/account/settings` writes only personal preferences to
`user_configs` namespace `os.preferences`, keyed by the caller's organization.
`userSettings.updatePreferences` is a full replace guarded by
`expectedRevision`; a conflict returns `currentRevision` and writes nothing. An
unset read returns defaults with `source: "default"` and `revision: 0`. Every
stored preference must change something (`data-density`, `data-motion`,
`data-contrast`, `lib/format.ts`, `lib/time.ts`); preferences with no consumer
are labeled stored-only. `userSettings.getContext` projects tenant identity and
effective permissions read-only.

Organization-wide changes live on their own routes, mainly `/admin`, `/team`,
and `/apps`. `/admin` links to customer-manageable configuration only; platform
telemetry belongs to operator surfaces.

## Navigation

- Work, Chat, Workspaces, and Outputs are fixed primary links. Capabilities
  groups Team, Skills, Apps, and Brain; Manage groups Blueprints, Audit, and
  Usage & budgets.
- Pinned workspaces come from favorites; Recent expands unpinned history. Empty
  sections and zero counts are hidden.
- The header organization picker uses the workspace directory and broker
  handoff.
- `Cmd/Ctrl+K` searches routes and resources (workspaces, Gadgets, outputs,
  apps, skills, recent runs) and navigates to the owning route.
- `@tedix/design-tokens` supplies density, spacing, radius, and typography;
  `apps/os` owns composition. See [design](design.md).

## Local development and verification

- `cd apps/os && bun run dev:fixtures` runs the SPA against contract-validated
  fixtures with no accounts or credentials.
- `bun run-local` runs the SPA against an isolated local API and D1. First
  run goes through the real bootstrap and onboarding contracts at
  `http://{slug}.localhost:3030`; no sample data is created unless `--demo` is
  passed.

Every new operation needs contract and MCP tests. Every new Layer 2 scope needs
tests for schema bounds, API arguments, compact results, typed errors, and the
exact Query keys invalidated by writes. User-visible changes also need browser
checks for sign-in, two-tenant isolation, and the affected route. Local green
checks prove the implementation, not deployed behavior.

See [DEVELOPMENT.md](../DEVELOPMENT.md) for lanes and prerequisites.

## Related

- [Architecture](../ARCHITECTURE.md)
- [Design system](design.md)
- [MCP runtime](../mcp/runtime.md) and [MCP Apps](../mcp/apps.md)
- [Kernel execution model](../cognition/kernel-execution-model.md)
- [Work Items](../cognition/work-items.md)
- [Collaborative editing ADR](../decisions/ot-authority.md)
- [Platform auth](../platform/auth.md)
