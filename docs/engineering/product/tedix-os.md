---
summary: "Tedix OS product contract: the multi-tenant apps/os application, per-organization origins, state ownership, the os MCP tool projection, and WebMCP layers"
read_when:
  - Changing the main Tedix working interface or its navigation
  - Integrating Work Items, workflows, tedis, MCP apps, widgets, artifacts, brain, or audit into Tedix OS
  - Deciding whether behavior belongs in Tedix OS or in an existing Tedix owner
  - Adding an OS operation that humans and agents must both reach
title: "Tedix OS"
---

# Tedix OS

Tedix OS (`apps/os`) is the one product frontend: a single multi-tenant Worker
serving every organization at `https://{slug}.os.tedix.dev` and a launcher at
`https://os.tedix.dev`. Routes live in `apps/os/src/routes/`; the Worker,
query-key, Cap'n Web, and capability-lifecycle traps are in `apps/os/AGENTS.md`;
visual rules are in [the design system](design.md).

## Invariants

- OS is a composition layer, never a second source of truth; `apps/api` and D1
  own committed records. It renders run state and never plans in the frontend.
- Every meaningful OS operation is an `osWorkspaces` oRPC contract verb that is
  also projected as an `os` MCP tool. A verb reachable only from the browser is
  a defect.
- A hostname is routing context, never authority. The API verifies caller,
  membership, tenant, and permission on every request.
- Live collaboration state (`CollabRoom`) is disposable. A revision becomes
  durable only through an explicit compare-and-swap Commit to D1.
- Notifications, sockets, and Query invalidation are hints; canonical API reads
  decide rendered state. Timer reconciliation is a correctness backstop, since
  events without a run id have no subscription.
- Untrusted content (Gadget previews, MCP Apps, widgets) renders only in
  explicit sandbox hosts; first-party routes never use an iframe.
- An OS approval never overrides a Tedix denial; installation never grants
  permissions automatically.

## Origins, sign-in, and sessions

Each organization has exactly one origin, so one person can keep several
organizations open in separate tabs without global tenant state. There are no
alias origins or custom domains for OS.

- **Provisioning.** The wildcard resolves every slug, so the Worker checks
  `organizations.features.os` through `API_SERVICE` and returns 404 before any
  HTML ships (`apps/api/src/rpc/routers/os-tenant.ts`).
- **Launcher.** `os.tedix.dev` stores no selected tenant and refuses `/api/*`.
  Launchers and switchers always go through broker-start URLs, so a stale
  cookie from another person cannot change identity during an app switch. The
  CLI picker at `/cli/login` returns only the selected slug over a state-bound
  loopback callback, never a tenant token.
- **First run.** `organizations.getMyOrganization` idempotently creates or
  repairs the organization, owner membership, identity tenant, and first tedi.
  `organizations.completeOsOnboarding` provisions the unified MCP gateway first
  and only then enables `features.os`, so a partial attempt stays
  non-launchable and a retry reuses what exists.
- **Sessions.** The session broker returns a single-use code; the Worker
  exchanges it over a Service Binding and writes the host-only
  `__Host-tedix-os-session` cookie. Browser code never sees the JWT, and refresh
  cookies exist only on the auth host. The Worker translates the cookie to a
  session header only on same-origin proxy requests, strips any browser tenant
  override, and asserts the hostname's tenant; a session for another tenant is
  reissued through the broker before the SPA mounts. See
  [platform auth](../platform/auth.md).

## State ownership

| Domain                                      | Owner                                                            | OS responsibility                                    |
| ------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| Work Items and projects                     | API + D1 ([Work Items](../cognition/work-items.md))              | Read, filter, steer, review through contracts        |
| Kernel and Home runs                        | Tenant kernel ([kernel](../cognition/kernel-execution-model.md)) | Start or steer work; render run state                |
| MCP gateway, apps, widgets                  | `apps/mcp`, `apps/mcp-ui` ([MCP runtime](../mcp/runtime.md))     | Call through grants; sandbox resources, preserve CSP |
| OS workspaces, Gadgets, Blueprints, outputs | D1 via `apps/api` (`packages/db/src/schema/os-workspaces.ts`)    | Render and revise committed revisions                |
| Live collaborative state                    | `CollabRoom` Durable Object in `apps/os`                         | OT stream and presence only; never writes D1         |
| Per-user OS preferences                     | D1 `user_configs`, namespace `os.preferences`                    | Revision-guarded full replace via `userSettings`     |

OS Chat is a Home/kernel surface; the embedded widget is the one chat surface
on the tedi runtime ([agent runtime](../tedi/agent-runtime.md)). Both share
`packages/chat-transport`. Deleting a Home conversation cancels its active runs
first, then purges conversation-owned kernel records in one D1 batch and leaves
a content-free tombstone so late events cannot resurrect it; accepted Work
Items and child-tedi ledgers survive, and shared R2 attachment blobs are not
erased.

## Workspaces

A Workspace is an organization-owned work context, not a user, tedi, runtime,
or credential folder. It groups conversations, Gadgets, outputs, resource
references, and links to Work projects. Delete requires `os:admin`, a prior
archive, no retained proposals, and no live share links.

- **Context.** `home.ask` accepts the same typed `workspaceContext` as OS chat;
  the API validates every id in the caller's organization and rejects a
  conflicting conversation. The kernel assembles the run's context envelope
  (platform safety > org policy > tedi identity > Workspace > conversation >
  Gadget > request); a lower layer adds detail but never grants a capability or
  selects a personal connection for an unattended tedi.
- **Direct reads.** An operator may run exactly one catalog tool declared
  `readOnlyHint: true` (`/read <appSlug>.<toolName> <JSON>`), bypassing Home
  routing; the MCP edge still enforces scopes. Writes stay on the Home/tedi
  path.
- **Delegation holds.** A `needs_approval` verdict parks the parent run as
  `requires_approval`; `respond_home_approval` resumes it once or cancels it
  without creating a child run.
- **Delegated UI.** The kernel promotes at most three validated
  `ui://widgets/mcp-app/...` targets with bounded, credential-stripped initial
  results into the Home message. Embedded hosts get visual parity only, not the
  guest tool-call bridge.
- **Gadgets** keep their own revisions and receipts, never copies of Work
  state. `run_os_gadget` dispatches the manifest's executable skill through the
  skill runtime; `approvalMode: "required"` can only make a run stricter.
  Custom export descriptors resolve from the revision pinned by a completed
  receipt and mint a five-minute Artifact Gateway URL; executions with
  resource-access envelopes are not exportable this way.
- **Workspace resources** are named, non-secret references to one provider
  object (`os_workspace_resources`), distinct from MCP protocol resources and
  from connections. Removing one does not revoke its connection. Gadget
  `resourceGrants` are rechecked at every run admission, and the skill runtime
  receives only a host-overwritten `_tedixContext` with no tokens.

## Sharing and Blueprints

- **Share links** cover one resource: outputs carry `viewer`, Gadgets and
  Workspaces `use` or `build`. A link never transfers the owner's credentials,
  memory, billing identity, or connections. The 256-bit secret is returned once
  in a URL fragment; D1 stores only its hash. Policy ceilings are monotonic: a
  tightening revokes every live session in the same D1 batch. Revisions from a
  Gadget run carry a secret-free provenance envelope, and links to them require
  a member whose current connections still satisfy every recorded scope.
- **Blueprint export** never includes credentials, grants, customer data, chat
  history, memory, or audit. Import creates revision 1 of a private draft with
  unattested lineage. Instantiate re-resolves requirements immediately before
  its D1 batch (the UI check is advisory), and later Blueprint revisions never
  silently rewrite existing Workspaces.

## Collaborative editing

See the [OT authority decision](../../../decisions/ot-authority.md).

- **Live edits.** The `CollabRoom` stream is server-held over one base; there is
  no offline log, and edits outliving the server's change window are lost on
  reconnect.
- **Commit** is a compare-and-swap; a lost swap blocks, says so, and refetches.
  A room behind canonical offers an explicit, warned **Replace with revision N**.
- **Agent proposals** are D1 review records pinned to an immutable base.
  Previews never move the current-revision pointer; a human accepts, and merge
  appends one revision and settles the proposal in one batch, failing if the
  base moved.
- **Presence** reduces the JWT to an opaque tenant-bound key, display name, and
  coarse role; it is memory-only and never authorizes an edit.

Outputs hold both the rich body and a headless projection (`OsOutputContent`);
`patch_os_document` and `set_os_sheet_range` keep them in step. Export fetches
no third-party assets. Library cards return an inert preview and never HTML,
formulas, or runnable content.

## One contract for humans and agents

Every OS operation is defined in
`packages/api-contract/src/contracts/os-workspaces.ts`, served by `apps/api`,
and projected as verb-first `os` tools through the tenant gateway. The
projection map lives in `apps/api/src/services/tool-schema-sync.ts`; do not
keep a parallel list. Mutations keep identity, FGA, policy, approvals,
`expectedRevision` concurrency, and audit. Two boundaries are intentional:
OAuth consent may need a person in a browser, and untrusted previews render in
sandbox hosts.

## WebMCP

A WebMCP-capable browser gets the OS as tools in two layers on the visitor's own
session; `apps/api` and the MCP edge stay the enforcing layers.

| Layer                  | Role                                    | Path                                                         |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------ |
| 1: tenant capabilities | The whole tenant gateway from any page  | Same-origin `/mcp` relay (`apps/os/src/webmcp/endpoint.ts`)  |
| 2: contextual actions  | Small actions for the surface on screen | `modelContext` tool → `osApi` → generated Query invalidation |

**One backend contract, two thin adapters.** Neither layer owns domain
behavior. Layer 2 may add descriptions, bounded inputs, compact results, deep
links, and confirmation, never authorization, persistence, or validation.
Hand-written `WebMcpToolDef` schemas are adapters, and parity tests fail when
they drift from `osApi`. Layer 2 must not call Layer 1 over `/mcp`. The layers
are not inventory mirrors: when both expose an operation they agree on
semantics, not names.

A route earns Layer 2 tools only for a coherent user intent whose operation
already exists in the API contract. Settings, navigation-only layouts, and
dangerous administration stay Layer 1; never expose accept/start/settle,
credential, permission, or destructive verbs just because a button exists.
A scope registers only once its tenant and API client are ready (otherwise
tools return a retryable `context_unavailable`); each document binds its own
tenant. `window.__tedixWebMcp.status()` reports host detection and the last
registration error. A successful mutation means only that the API accepted it.

## Embedded provider installations

Tedix can back a host SaaS product's embedded Tedi widget with one isolated
organization, workspace, and tedi per host business
(`apps/api/src/rpc/routers/tedis/provider-onboarding.ts`,
`apps/api/src/rpc/routers/tedis/widget-access.ts`).

- `tedis.provisionProviderInstallation` (platform admin) resumes partial work
  by stable keys; it does not enable OS or start a runtime.
- `tedis.activateProviderCustomer` derives the provider and defaults from the
  caller; callers cannot choose them.
- Assistant access starts off. The audience is all or selected host users minus
  exclusions (exclusions win); session exchange and every embedded operation
  recheck it, so disabling stops new turns.
- A host's portable Layer 2 profile admits only enabled `read`-classified tools,
  rechecked at session exchange.

## Capabilities and sites

Apps, Skills, and connections are distinct inventories: skills explain how to
do work, apps expose tools, connections supply credentials. Each reports its
facts separately: a connection badge only confirms a credential exists, and an
MCP protocol check describes the app service, not the provider or credential.
Gateway membership (`apps.setGatewayMembership`) is separate from installation
and connection, never widens client scopes, and purges the discovery cache.
`sites.list` combines CMS sites and docs deployments; archive pauses delivery
without deleting state ([Emdash CMS](../emdash/cms.md)).

The profile (`/account/profile`) derives the user from the verified credential;
D1 owns name and avatar, the identity provider owns email, MFA, and sessions,
and provider claims never overwrite user edits. Without a provider webhook an
email change can stay stale until the next bootstrap.
