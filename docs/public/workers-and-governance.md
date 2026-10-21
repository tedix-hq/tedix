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

If you need to know what a Tedix tedi may do, start with Permissions. This guide explains how access is limited and what records help you review its work. A tedi stays part of an organization over time. It is not a one-time task. It is accountable for work done by an agent instead of a person.

## What a tedi has

- its own identity and role in the organization;
- skills and connected tools it has been granted;
- memory that belongs to the organization;
- policies, budgets, and approval requirements;
- runs, rationale, and artifacts from past work;
- a runtime that can restart or change without changing who the worker is.

Tedix keeps each tedi's identity separate from the computing resources it uses. Routine tasks run on a managed service. A job that needs a browser, a repository, or computer programs gets a temporary workstation, not permanent access to a machine.

## Four rules

| Rule                                   | What it means                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Identity persists                      | The worker, its memory, and its record survive the run, the session, and runtime changes.   |
| Budgets hold                           | The owner sets spend and capacity limits. A worker cannot raise its own.                    |
| Approval follows the mutation policy   | A boundary can require an independent designated approver: a person or another worker.      |
| The record shows who did what, and why | Who asked, who acted, under which policy, with which sources, at what cost, and the result. |

## Permissions

A worker gets an identity, a role, policies, tool grants, and spending limits.
Approval policy applies at each mutation boundary. A boundary may require a
durable grant or an independent designated approver, which can be a person or
a tedi. Other scoped Code Mode actions can use agent auto-confirm; there is no
universal human-confirmation requirement. Consent, MFA, and user presence
remain human steps. Delegating work to another worker passes only the scope
that work needs, not every permission the delegating worker holds.

A tedi acts under its own identity rather than signing in as the person who
asked. The requester stays on the record, but their permissions are not
copied to the tedi.

## Critical-only autonomy

An organization can opt into low- and medium-risk delegation and tool actions
with an immutable policy-pack revision containing
`governancePolicy.autonomy: { "version": 1, "maxRisk": "medium" }`.
Organizations without this setting keep their existing approval policy.

For tool writes, enable `governancePolicy.writeTier.autoApproveLowRisk` and
set `governancePolicy.writeTier.trustedTools` to the permitted tool patterns.
An explicit `"*"` pattern provides standing consent within existing grants;
high-risk and critical actions still require a human.

Home dispatches eligible work immediately, waking a standby tedi when needed.
Coding work is spread across tedis that share the same repository, least busy
first. Its Feed receipt identifies the task, tedi, and outcome. **This should
have asked me** saves an owner/admin correction lesson that requires approval
for that delegation class next time.

Each tedi takes two delegated runs at a time unless its policy pack sets
`workItemConcurrency` (at most eight). A delegation to a busy tedi waits in the
queue, oldest first, and starts when a slot frees. Being busy is not a risk
decision, so it creates no approval card for a person.

The same autonomy setting lets Tedix answer some internal questions itself: a
reversible follow-up, such as creating an internal Work item, is created
directly instead of becoming a Deck card. The Feed shows a receipt with
**Undo**. Questions about consent, credentials, roles, deletion, money,
publishing or legal matters still go to a person.

High-risk work and critical actions still require a human: money or budget
changes, external messages, public publishing, consent or credentials,
sign-in or MFA, access changes, data deletion, and production authentication
or provider settings. Existing scopes, spending limits, runtime readiness,
and repository push gates still apply. Unclassified execution stays gated.

An owner/admin can run `sweep_delegation_autonomy` to recheck existing Home
delegation holds against the current policy. Carry its returned cursor until
there are no more pages. Policy releases retain an audit record; critical and
explicitly held requests remain pending. Repeating the sweep does not create
another child for an already resolved delegation.

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
me which Documents are listed." The tedi uses its existing identity through
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

## Review outbound work

An outbound Work item keeps a draft with the project that requested it. It can
represent an email, social reply, post, proposal or invoice. The draft carries
the recipient, channel, author, reasoning, source facts and risks. A factory or
local session can submit it through `submit_outbound_draft`; it does not send
anything.

Organization administrators configure reviewer tedis by channel and topic in
D1 through `configure_outbound_review`. There is no built-in organization or
department roster. The selected tedi checks voice, source grounding and
commitments, then submits its verdict through `review_outbound_draft`. Sources
that cannot be checked should block approval or require changes.

After review, the addressed person sees an Outbound card in Work → Deck.
Work → Feed → Apps → Outbound lists the same Work items.
The card shows the draft, reviewer notes and grounding. Edits invalidate the
review and return to the reviewer. An existing open input request or question
can become the card without changing its original prompt or history.

“Approve & send” is available for email through the person's own verified Gmail
connection with compose consent. It creates and sends the reviewed text only
after the person clicks. “Approve (I'll send)” records approval while leaving
delivery unconfirmed; other channels offer copying and a supplied draft link.
A timeout after sending locks the card for reconciliation rather than retrying
and risking a duplicate. Approval never completes the broader Work outcome.

Approvals, edits, feedback and rejection are recorded with their draft revision.
Approval is a positive style example; an edited approval retains the original
and final wording. These signals enter the existing personal/team lesson
pipeline and the reviewer receives the feedback. The person's profile shows
their last ten approvals. They can also import up to ten sent emails through
their own read-consented Gmail connection. Raw imported mail stays in their
personal style store; only aggregate style measurements reach the reviewer.
