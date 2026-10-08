---
summary: "Work factory invariants: Work Items, admission, Attempts, settlement, approvals, and interactions"
read_when:
  - Updating Work Item, case, milestone, approval, interaction, admission, attempt, resource, budget, settlement, or fleet behavior
  - Designing coding or non-coding work for humans, tedis, or external agents
title: "Work factory"
---

# Work factory

One artifact-neutral factory for bounded organizational outcomes. Portfolio
state, specification, execution permission, coordination, and external
projections have independent lifecycles; no provider, runtime, transcript, or
UI view is a second source of truth.

**Admission is the only gate; settled means done.** There is no review or
evidence gate between settlement and completion. Read
[minimal-gates-over-pre-proof](../../../decisions/minimal-gates-over-pre-proof.md)
before adding one.

Code: `packages/db/src/queries/work-items/` (persistence and invariants),
`packages/api-contract/src/{contracts,schemas}/work-items.ts`,
`apps/api/src/rpc/routers/work-items/` and `work-approvals.ts` (derive the
authenticated principal; never trust actor input).

## Records

| Question                                  | Record                                     |
| ----------------------------------------- | ------------------------------------------ |
| Why are we investing? / What is due?      | Objective, project, milestone              |
| Which emergent body of work?              | Case                                       |
| What bounded outcome must be produced?    | Work Item                                  |
| May a specific executor act now?          | Derived readiness plus immutable admission |
| Which scarce capacity is held?            | Resource and budget reservations           |
| What is executing?                        | Fenced Attempt                             |
| What must another principal answer or do? | Typed interaction and immutable response   |
| Which exact proposal was approved?        | Approval proposal and decision             |
| What did the executor do?                 | Attempt settlement (with commits)          |
| Who agreed or disagreed afterwards?       | Corroboration ledger                       |

Never infer project health from percentage done, a deployed surface from a
settled Attempt, or permission from an assignment label. Project health is an
immutable judgment by an accountable principal. A milestone's `proofRef` never
substitutes for its linked work. Closing a case does not complete its items.
Todo, Kanban, and Gantt are views over the same rows.

A Work Item's disposition (`proposed` → `accepted` → `completed` | `cancelled`)
is independent of execution. Acceptance fixes one plain-language
`doneLooksLike`. The acceptance schema still parses an older shape (`claims[]`,
`evidenceKinds`, `requiresIndependentReview`, ...) so stored rows stay readable;
no gate consults it, and new items must not use it. No `workKind` requires Git.

## Readiness and admission

Readiness, scheduling, and admission share one eligibility evaluator, and hard
eligibility precedes ranking:

```text
eligible = accepted AND purpose_active AND dependencies_satisfied
       AND capability_satisfied AND authority_satisfied AND approvals_satisfied
       AND risk_policy_satisfied AND resources_available AND budget_available
       AND no_active_attempt
```

A rank never compensates for failed eligibility. Unknown or truncated facts
fail closed (`factsTruncated` returns `evaluation_required`); `graphTruncated`
only means critical-path ranking is partial. `work clusters` waves grant
nothing.

**`start` is the only operation that grants execution.** In one atomic boundary
it validates the item version, admission-spec revision, executor identity and
capabilities, dependencies, approvals, risk, resources, and budgets; records
the admission; creates reservations; and creates a fenced Attempt. Readiness
and scheduler results are advisory snapshots. `tedix work start --worktree`
provisions a worktree only after admission succeeds; a provisioning error does
not roll back admission.

Resources and budgets: active reservations never exceed pool capacity, and
reservation plus consumption never exceeds the most specific budget envelope.
Edits are exact-version CAS, never last-write-wins. Resource keys match exactly:
the server infers no path conflicts, so actors touching the same thing must use
the same key. Only owner/admin users write pools or budgets; an executor that
can raise its own ceiling has no ceiling.

## Attempts

At most one active Attempt owns a Work Item:
`accept → admission → start → heartbeat → settle → complete`.

- **Fence.** Every Attempt-owned mutation proves the current Attempt, executor,
  immutable session, and live lease in the same statement as the write, so a
  revived stale executor cannot mutate state.
- **Lease.** Expiry takes effect before it is materialized: reads ignore an
  elapsed lease and heartbeat/settle reject it. The next `start` marks it
  `expired`, releases resources, settles the budget to committed spend, and
  creates a new Attempt. There is no revive or late settle.
- **Delegated runs** bind their Attempt once and renew the lease inside the
  runtime, including during quiet tool or model waits.
- The CLI's cached Attempt id is a lookup pointer; the server is checked on
  every call.

Durable execution does not give exactly-once external effects. Provider writes
still need idempotency keys, final-state readback, and compensation.

## Settlement and completion

`settle` records the outcome, a summary, and the commits that produced it
(`metadata.settlement.commitShas`), and retires reservations. The CLI resolves
each sha in the local checkout before recording it. `complete` is one
idempotent call whose only guard is the concurrency CAS (accepted, expected
version, no active Attempt); `work.completed` is written in the same
`db.batch()`.

Wrong claims are corrected afterwards, not pre-proven:
`work_item_corroborations` lets a second principal agree or contradict (once
per principal; an executor may contradict but not corroborate its own claim).
`work_evidence` is optional telemetry; `work_evidence_verifications` holds
historical rows only. Nothing re-reads a live surface after settlement, so a
settled Attempt is not proof of deployment.

Coding commits link through one contiguous final trailer paragraph:

```text
Work-Item: <uuid>
Agent-Session: <harness>:<immutable-session-id>
```

A repository state never grants execution; only admission does.

**Artifacts repositories.** `startAttempt` may create or fork one per-Attempt
Cloudflare Artifacts repository
(`apps/api/src/services/work-artifacts-repository.ts`, gated by
`WORK_ATTEMPT_ARTIFACTS_ENABLED`) after admission. Write tokens never enter D1,
logs, or responses. Any failure yields `repository.status: "unavailable"` and
never falls back to a shared repository; callers must check it. Settlement may
attach a `repositoryLifecycle` receipt (merge into `github_main`, deployment
observation); these are checkable claims, not gates. Artifacts does not replace
the GitHub `main` ledger, trailers, the pre-push gate, or live verification.

## Interactions and approvals

**Interactions** (`question`, `input`, `handoff`, `coordination`) target one
concrete user, tedi, or external agent; untargeted or team pseudo-targets are
rejected. Resolution is fenced so concurrent responders produce one winner. An
interaction may unblock work but never approves or completes; comments are
never parsed as responses. Inbox (exact target, `canRespond`), outbox (own
requests, `canCancel`), and the owner/admin audit ledger (neither) are separate
projections. Notifications are hints; reload before acting.

**Admission approvals** bind `workItemId`, `workItemVersion`, an `authorityKey`
(the item's `requiredAuthorities` plus server-derived `risk:high` /
`risk:critical`), and a designated approver. Admission consumes only an approved
proposal for the same revision and exact key.

- Self-approval is rejected; external agents cannot decide.
- Stale, expired, rejected, or cancelled proposals cannot be revived; let an
  unavailable approver's proposal expire and propose again.
- `human_approval` does not itself enforce approver type; a human-only decision
  must designate a human.
- A harness subagent is context isolation inside its parent's Attempt, not a
  Work principal.
- Before accepting a required authority, make sure an active principal other
  than the requester can approve, or the item can never be admitted.

| Step                                              | Non-human alone?        | Rule                                                                  |
| ------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| Create, comment, open an interaction              | Yes                     | Any verified active actor (`verifiedActiveWorkActor`)                 |
| Accept the specification                          | Yes, with `work:accept` | Owner/admin users unscoped; tedis and agents need `WORK_ACCEPT_SCOPE` |
| Start, heartbeat, settle an Attempt               | Yes                     | Tedi or verified external-agent session; users cannot execute         |
| Complete; corroborate; propose an approval        | Yes                     | Completion CAS; once per principal; any principal                     |
| Decide an admission approval                      | Not an external agent   | Designated user or tedi distinct from the requester                   |
| Cancel; replace admission spec; pools and budgets | No                      | Owner/admin user                                                      |

`requireActivePrincipal` checks every designated principal against the item's
organization; approvers never act across organizations.

## Parallel work

Parallel work uses distinct Work Items and Attempts. Waiting for approval is a
proposal, waiting for input is an interaction, and a model turn is never held
open as a lock. Disjoint files in separate worktrees run in parallel; a shared
file or contract takes an exclusive `file:<repo>:<path>` key; a feature
spanning files takes one `feature:<repo>:<name>` pool; a shared production
surface or migration builds in parallel with one activation owner.

The fleet control tower is a bounded derived projection: census counters count
every row, `attention.actions` only actionable pressure. It grants nothing, and
an empty queue does not mean every item is healthy.

Do not repeat an unchanged failed plan: read the Attempt, rejection,
interaction, and events, then change the plan or open an interaction. A
conflict means recompute from current state, never bypass the fence.

## Deliberately not implemented

- A writable universal status mixing portfolio, readiness, execution, and
  approval.
- Comments-as-approval, comments-as-response, or URL-as-completion parsing.
- Provider tasks, transcripts, or Artifacts repository state as execution
  authority.
- Unbounded fleet reads, client-side full-board scheduling, or capacity edits
  without a version fence.
- All-to-all agent chat as a coordination substrate.
- A pre-proof gate, verifier, or required receipt without a real failure it
  would have caught.
