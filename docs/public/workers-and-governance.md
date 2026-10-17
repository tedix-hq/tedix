---
sidebar:
  order: 40
title: "Worker permissions, approvals, and governance"
topic: "Platform"
resource_type: guide
description: "What a Tedix worker is, how its permissions are limited, and what Tedix records about its work."
summary: "The Tedix worker model, approvals, audit records, and repository controls"
read_when:
  - Understanding the Tedix worker model
  - Evaluating approvals, permissions, and audit records
  - Choosing controls for a repository changed by coding agents
visibility: public
---

# Worker permissions, approvals, and governance

A digital worker in Tedix is called a **tedi**. A tedi is a long-lived member
of an organization, not a single model call. It is the unit that answers for
work done by an agent instead of a person.

## What a worker has

- its own identity and role in the organization;
- skills and connected tools it has been granted;
- memory that belongs to the organization;
- policies, budgets, and approval requirements;
- runs, rationale, and artifacts from past work;
- a runtime that can restart or change without changing who the worker is.

Tedix keeps the worker separate from the compute it uses. Routine work runs on
Cloudflare Workers. A job that needs a browser, a repository, or operating
system processes gets a workstation for that job only, not permanent machine
access.

## Four rules

| Rule                                   | What it means                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Identity persists                      | The worker, its memory, and its record survive the run, the session, and runtime changes.   |
| Budgets hold                           | The owner sets spend and capacity limits. A worker cannot raise its own.                    |
| The approver is never the requester    | A protected action is approved by someone else: a person or another worker.                 |
| The record shows who did what, and why | Who asked, who acted, under which policy, with which sources, at what cost, and the result. |

## Permissions

A worker gets an identity, a role, policies, tool grants, and spending limits.
Sensitive operations can require approval before they run. Delegating work to
another worker passes only the scope that work needs, not every permission the
delegating worker holds.

A tedi acts under its own identity rather than signing in as the person who
asked. The requester stays on the record, but their permissions are not
copied to the tedi.

## Persistent browser sessions

To keep one browser's tabs, cookies and logins across a tedi's turns, set
`browserSession` in its `toolPolicy` (`tedis.update` replaces the whole
`toolPolicy`, so send its other fields too):

```json
{ "browserSession": { "mode": "persistent", "name": "research" } }
```

`keepAliveMs` (60000 to 600000, the default) is the idle time before Browser
Run reclaims it. A lost browser is replaced on the next call, and the tedi is
told it restarted and may need to sign in again. Budget, hostname, approval
and human takeover policies still apply. Use `{ "mode": "dynamic" }` to stop.

Hostname rules (`browserEgress` on the organization and the tedi) become
Browser Run guardrails: the browser launches with the allowlist both rules
share, so every page and request it makes is limited to those hostnames,
between tool calls and after a restart. When the rules change, the next call
closes the browser and launches a new one. Guardrails cannot express a
denylist, so the tedi cannot run browser code while a denied hostname is
reachable; list allowed hostnames instead.

The run ledger records each browser as `browser.session.opened`, `reused`
(once per run), `restarted` or `closed`. The tedi can read its session with
`browser_session_status` and end it, discarding its logins, with
`browser_session_close`.

### Console sign-in and human takeover

A human organization owner or admin can enable **Allow Tedix console
sign-in** in the tedi's settings. It adds the `tedix-console-sign-in`
hostname preset to `toolPolicy.browserEgress.presets`, covering the console
and its sign-in dependencies. Organization restrictions, tedi policies and
approval requirements still apply. This permits browser traffic; it grants
no console identity or Workspace access.

In workspace chat, ask "Open the console; request a takeover if sign-in
needs me." For a takeover, open its approval and press **Open live view**.
The server checks the current browser before opening it. Complete the
human sign-in, consent or MFA step yourself, then approve continuation. The
approval wakes the originating tedi session, which must read takeover status
and continue only when `continuationReady` is true on the same browser.
If that browser has gone, ask for a new takeover. A replacement request for
the same browser supersedes its earlier approval; an old live-view link is
not proof the session is still available.

### Tedi console access

A tedi can sign in as itself to a small read-only console. Access starts
disabled. An active human organization owner or admin opens **Team → tedi →
Settings → Console access**, selects Workspaces they can open, enables
**Allow console access (read-only)** and saves. Neither a tedi nor an
external agent can grant this access.

The console shows the tedi's identity, selected Workspace names and
descriptions, and Output titles and kinds. It does not expose Output bodies,
connections or the human console. Sessions last at most five minutes;
every read checks the current grant and active tedi. Saving a grant change
revokes existing sessions. Creation and reads are audited as the tedi.
The session cannot write, run, approve or widen its own access.

From workspace chat, ask "Read this Workspace in your own console and tell
me which Outputs are listed." The tedi uses its existing identity through
the session broker and the organization's `/tedi-console` entry; it must
never borrow a human session or expose credentials in chat, links or logs.
If access is missing, give the administrator the exact setting above.
Changes still use the normal governed Work and approval path; an approval
does not turn the read-only console session into a write credential.

## What Tedix records

- who or what asked for the work;
- which worker or external agent did it;
- the tools and sources it used;
- approvals and policy decisions;
- the artifacts it produced and any provider references for outside actions;
- costs, where the provider reports them.

A settled result is what the worker reported. Completion does not require a
separate review, and it does not mean the result is correct. When someone
checks the result, they can record that it held up or that it did not.

Governance does not make every automated decision correct. It limits what a
worker may do, keeps the record, and makes review and rollback possible.

## Compared with the Agent Access Model

[Cloudflare's Agent Access Model](https://blog.cloudflare.com/the-agent-access-model/)
describes a reference architecture for agent permissions. This table compares
current Tedix behavior with it; it is not a claim of conformance.

| Model component           | Tedix today                                                                               | Gap                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Agent Identity Broker     | Tedis and external agents have distinct identities.                                       | No per-task, sender-bound credential that carries the requester and task.               |
| Task-scoped Access Engine | Policy packs, MCP scopes, skill manifests, and Work Item admission limit different paths. | No single per-action ceiling across task, requester, agent, resource owner, and tenant. |
| Mediation Layer           | The MCP edge, skill allowlists, and workstation egress broker check their own paths.      | No shared task state enforced across every tool, process, and network hop.              |
| Trust Ratchet             | Static grants, budgets, approvals, and expiring leases limit work.                        | No automatic one-way narrowing of permissions across a task graph.                      |
| Agent Activity Log        | MCP and Code Mode telemetry, Work Items, and audit tables record who did what.            | No single append-only log of a whole task graph including network activity.             |
| Grant Review Loop         | People can correct Work Item outcomes and change grants.                                  | No automatic recommendations for future grants.                                         |

The code behind each row starts in `packages/auth/src/principal-identity.ts`,
`packages/mcp/src/auth/scopes.ts`, `apps/mcp/src/index.ts`,
`apps/tedi-workstation-egress-broker/src/index.ts`, and
`packages/db/src/schema/audit-events.ts`.

## Repositories changed by agents

Use the lightest controls that cover the repository's real risk. Tedix does
not require any special Git service or key.

- Keep normal tests, branch protection, and risk-appropriate reviews.
- Link the Work Item, agent run, and commit when attribution helps.
- Give agents only the repository and deployment permissions the task needs.
- Check source changes, test runs, and production behavior separately.
- Keep changes small and keep a tested way to roll back a release.

A commit reference names a change; it does not show that tests passed or that a
deployment worked.
