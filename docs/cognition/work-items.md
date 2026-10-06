---
summary: "Work factory records, invariants, and lifecycle: Work Items, admission, Attempts, settlement"
read_when:
  - Updating Work Item, case, milestone, approval, interaction, admission, attempt, resource, budget, settlement, or fleet behavior
  - Designing coding or non-coding work for humans, tedis, or external agents
title: "Work factory"
---

# Work factory

Tedix has one artifact-neutral factory for bounded organizational outcomes.
Portfolio state, work specification, execution permission, structured
coordination, and external projections have independent lifecycles. No
provider, runtime, transcript, or UI view is a second source of truth.

**Admission is the only gate; settled means done.** There is no review or
evidence gate between settlement and completion. See
[minimal-gates-over-pre-proof.md](../decisions/minimal-gates-over-pre-proof.md)
before adding one.

## Record map

| Question                                          | Record                                     |
| ------------------------------------------------- | ------------------------------------------ |
| Why are we investing?                             | Objective and project                      |
| Which emergent body of work are we managing?      | Case                                       |
| Which portfolio outcome is due?                   | Milestone                                  |
| What bounded outcome must be produced?            | Work Item                                  |
| May a specific executor act now?                  | Derived readiness plus immutable admission |
| Which scarce capacity is held?                    | Resource and budget reservations           |
| What is executing?                                | Fenced Attempt                             |
| What must another principal answer or do?         | Typed interaction and immutable response   |
| Which exact proposal was approved?                | Approval proposal and decision             |
| What did the executor do, and with which commits? | Attempt settlement                         |
| Who else agreed or disagreed with the outcome?    | Corroboration ledger                       |
| What happened in order?                           | Append-only Work event                     |
| Where is an external copy or source?              | Projection/source identity                 |

Never infer project health from percentage done, a deployed surface from a
settled Attempt, or permission from an assignment label.

## Portfolio and case plane

- **Projects** are accountable, non-executable containers linking an objective,
  owner, horizon, milestones, cases, budgets, and Work Items. Health is an
  immutable judgment by an accountable principal (`on_track`, `at_risk`,
  `off_track`, `paused`) with rationale; the latest one is displayed.
- **Milestones** name an outcome, target date, stage, acyclic dependencies, and
  linked Work Items. `done` requires linked required work and prerequisite
  milestones to satisfy their guards; its `proofRef` never substitutes for them.
- **Scheduling and sprints.** A Work Item may carry `startAt` and
  `durationDays`. A sprint is a project-scoped window (`planned`, `active`,
  `completed`, `cancelled`) that groups Work Items without copying their state.
  Todo, Kanban, and Gantt are views over the same data.
- **Cases** organize emergent work with stage, owner, dependencies,
  attachments, and membership. Closing a case does not complete its items.

The hierarchy stays small: `objective → project → milestone → Work Item`, with
cases as dynamic containers.

## Work specification plane

A Work Item records one bounded outcome: UUID, organization, purpose link,
title, description, kind, risk, priority, accountable principals, dependencies,
capability and authority requirements, resource and budget requirements, an
immutable acceptance contract, provenance, and version.

Business disposition is independent of execution:

- `proposed` — specification may still change;
- `accepted` — acceptance is fixed and admission may be evaluated;
- `completed` — closed after execution;
- `cancelled` — abandoned with rationale.

`workKind` covers coding, research, document, design, browser, operations,
communication, finance, legal, stewardship, incident, and other work. No kind
requires Git.

**Acceptance** fixes the outcome before execution and makes an item
admissible. Its shape is one plain-language `doneLooksLike` string. The
`WorkItemAcceptanceContractSchema` also parses an older shape (`claims[]`,
`evidenceKinds`, `minimumAcceptedEvidence`, `requiresIndependentReview`) so
stored rows stay readable; no gate consults those fields. Do not write new items
in that shape.

## Readiness, admission, and scheduling

Readiness is a derived snapshot for the current specification revision. It
returns `evaluation_required` when executor-specific facts are unavailable.
Readiness, scheduling, and admission share one eligibility evaluator, and hard
eligibility precedes ranking:

```text
eligible = accepted
        AND purpose_active
        AND dependencies_satisfied
        AND capability_satisfied
        AND authority_satisfied
        AND approvals_satisfied
        AND risk_policy_satisfied
        AND resources_available
        AND budget_available
        AND no_active_attempt
```

The scheduler returns a bounded advisory queue with an inspectable policy
revision, ranked by priority, urgency, age, critical-path impact, cost, and
risk. A rank never compensates for failed eligibility. Unknown or truncated
eligibility facts fail closed: `factsTruncated`/`truncatedFacts` withholds the
queue under `evaluation_required`, while `graphTruncated` only means
critical-path ranking is partial.

`work clusters` turns the ranked set into sequential waves whose items fit the
remaining resource capacity and do not share an exclusive pool. Waves grant no
permission; each `start` resolves the live admission race.

**`start` is the only operation that grants execution.** In one atomic boundary
it validates the Work Item version and admission-spec revision, executor
identity and capabilities, dependencies, approvals, risk policy, resources, and
budgets; records the admission decision; creates reservations; and creates a
fenced Attempt. Rejections are typed; replaying an identical rejected request
is deduplicated. Readiness and scheduler results are advisory snapshots.

For a local coding harness, `tedix work start <id> --worktree` provisions a Git
worktree only after admission succeeds, on a branch/path derived from the Work
Item, Attempt, and Agent-Session. Collisions and foreign metadata fail closed
without deletion. A provisioning error does not roll back admission.

## Resource and budget plane

A resource pool defines a typed capacity key, an `exclusive` or `capacity`
mode, and a positive capacity. A Work Item declares quantities; admission
reserves them for the exact revision. Active reservations never exceed pool
capacity; expiry and settlement release them idempotently.

Budget envelopes exist at organization, project, case, or Work Item scope, with
currency, limit, committed/available accounting, and a CAS version. The most
specific envelope constrains admission; reservation plus consumption never
exceeds the limit. Edits are exact-version mutations — no last-write-wins.

Resource keys match exactly. The server does not infer parent/child path
conflicts, compare diffs, or enforce file ownership; actors that touch the same
thing must reuse the same key. Replace requirements only on pending work, never
on a running Attempt.

## Execution plane

An Attempt records executor type/id/session, immutable admission id, attempt
number, runtime state, lease timestamps, outcome, summary, and metadata. At
most one active Attempt owns a Work Item.

```text
accept → readiness/admission → start → heartbeat → settle → complete
```

- **Fence.** Every Attempt-owned mutation proves the current Attempt, executor,
  immutable session, and live lease in the same statement as the write. A
  revived stale executor cannot mutate state.
- **Lease.** Expiry is effective before it is materialized: readiness and
  scheduling ignore an active row whose `expiresAt` has elapsed, and heartbeat,
  telemetry, and settlement reject it as stale. The next successful `start`
  marks timed-out rows `expired`, releases their resource reservations, settles
  their budget reservation to the spend actually committed (released when
  nothing was spent), and creates a new Attempt. There is no revive or
  late settle.
- **Delegated runs.** A Home-delegated turn binds its Attempt once and renews
  the lease inside the runtime, including during quiet tool or model waits.
  Renewal stops when execution returns, fails, or is canceled.
- **Local state.** The CLI's cached Attempt id is a lookup pointer only; the
  server is checked on every call.

Durable execution does not guarantee exactly-once external effects. Provider
writes still need idempotency keys, provider concurrency controls, final-state
readback, and compensation where useful.

## Settlement and completion

`settle` records `succeeded`, `failed`, `cancelled`, or `expired`, a summary,
and the commits that produced the outcome (`metadata.settlement` with
`commitSha`/`commitShas`), and retires reservations. The CLI resolves each sha
against the local checkout, so a nonexistent commit fails before it is
recorded.

`complete` is one unconditional, idempotent call. Its only guard is the
concurrency CAS: accepted disposition, exact expected version, and no active
Attempt. It counts no evidence and requires no reviewer; a repeated call reads
the completed row back. The `work.completed` event is written in the same
`db.batch()`.

Wrong claims are corrected after the fact rather than pre-proven:

| Record                        | Purpose                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `work_item_corroborations`    | A second principal records agreement, or a contradiction that the outcome is false. |
| `work_evidence`               | Optional execution telemetry under the live fence.                                  |
| `work_evidence_verifications` | Historical rows from retired verifiers; nothing writes new ones.                    |

A principal counts once per item and may change its stance. An executor may
contradict its own settled claim but cannot corroborate it.

Nothing re-reads a live surface after settlement, so a settled Attempt is not
proof of deployment. Check the surface's deployed version directly.

### Commit trailers

For coding work, a commit links to its Work Item through one contiguous final
trailer paragraph:

```text
Work-Item: <uuid>
Agent-Session: <harness>:<immutable-session-id>
```

`work settle --commit <sha>` (repeatable) binds those commits to the Attempt
outcome. A repository state never grants execution permission — only admission
does.

### Isolated Artifacts repositories

`startAttempt` may opt into one Cloudflare Artifacts repository with
`repository: { mode: "create" }`, or fork an existing repository with
`repository: { mode: "fork", sourceRepositoryName, sourceRef,
expectedBaseRevision? }`. This is an execution workspace, not another authority
plane:

- admission and the live Attempt fence are established first;
- `apps/api/src/services/work-artifacts-repository.ts` creates or forks the
  deterministic per-Attempt repository through the API Worker's `ARTIFACTS`
  binding;
- a fork resolves `sourceRef` to one exact commit before creation and rejects an
  `expectedBaseRevision` mismatch;
- `packages/db/src/queries/work-items/attempts.ts` persists the secret-free
  repository id, remote, base revision, Work Item version, admission revision,
  admission id, and Attempt id under the same live executor/session/lease fence;
- the initial Artifacts write token is discarded. Tokens are short-lived
  capabilities and never enter D1, logs, or the API response.

`WORK_ATTEMPT_ARTIFACTS_ENABLED=true` is also required. An unavailable beta,
missing account entitlement, disabled flag, unresolved source ref, or provider
error yields a typed `repository.status: "unavailable"` receipt on the Attempt;
it never grants authority or silently falls back to a shared repository. The
caller must inspect that status before handing a repository to an executor.

At settlement, an Artifacts-backed Attempt may attach the typed
`repositoryLifecycle` receipt. It preserves the Artifacts `headRevision`, a
review disposition with an evidence reference, a merge receipt, and a live
deployment observation. A claimed merge is valid only when it names
`canonicalLedger: "github_main"`, the GitHub repository, merge commit, and
timestamp. A claimed deployment or deployment failure names the surface,
deployed revision, evidence reference, and observation time. The settlement
query preserves the original repository/admission/base receipt and rejects
caller metadata that tries to overwrite either reserved repository block.
These are checkable settlement claims, not pre-proof gates; corroboration or a
contradiction remains the correction path when a receipt does not reproduce.

Artifacts isolates agent work and preserves reviewable Git provenance. It does
not replace the monorepo's GitHub `main` ledger, the required commit trailers,
`work settle --commit`, the pre-push gate, deployment, or live verification.
Cloudflare's current binding contract is documented in the
[Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/).

## Structured coordination plane

Typed interactions (`question`, `input`, `handoff`, `coordination`) connect a
Work Item/Attempt to one concrete user, tedi, or external agent. Each has a
target, prompt, context, expiry, state, and immutable responses. Untargeted or
team/system pseudo-targets are rejected.

Lifecycle: open → resolved, cancelled, or expired. Responses are
`answer`, `input_provided`, `handoff_accepted`, `handoff_declined`, or
`coordination_update` and state whether they resolve the request. Resolution
is fenced so concurrent responders produce one winner. An interaction may
unblock work but never approves a proposal or completes an outcome; comments are
never parsed as responses.

Inbox, outbox, and audit ledger are separate projections. The inbox has only
exact-target rows (`canRespond`), the outbox only the actor's own requests
(`canCancel`), and the owner/admin audit ledger always returns `canRespond:
false` and `canCancel: false`. Notifications are hints; reload the interaction
and Work Item before acting.

## Approval plane

An admission approval proposal stores `workItemId`, `workItemVersion`,
server-fixed `action: admission`, the proposal, a validated `authorityKey`, the
designated `approverType`/`approverId`, rationale, requester identity/session,
and expiry. Valid keys are the Work Item's `requiredAuthorities` plus the
server-derived `risk:high` or `risk:critical`. Decisions are immutable
`approved`/`rejected` receipts carrying `resolvedProposalVersion`.

- Admission consumes only an approved proposal for the same Work Item revision
  and exact key. Approvals for other purposes never satisfy readiness.
- Self-approval is rejected; external agents cannot decide.
- Stale, expired, rejected, or cancelled proposals cannot be revived. If a
  designated approver becomes unavailable, let the proposal expire and propose
  again to another eligible principal.
- The approver inbox shows only proposals designated to that principal; the
  owner/admin audit ledger grants no decision right. Both are keyset-paginated —
  follow `nextCursor` while `hasMore` is true.
- A first-class tedi authenticates as its own principal and may be a designated
  executor or approver. A harness subagent is context isolation inside its
  parent's Attempt, not a Work principal.
- The `human_approval` key does not by itself enforce approver type; a decision
  reserved for a human must designate a human approver.

Before accepting a required authority, make sure at least one active principal
distinct from the requester can approve; otherwise the item cannot be admitted.

## Who may do what

| Lifecycle step                                   | Non-human principal alone? | Enforcement                                                                                       |
| ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| Create a Work Item, comment, open an interaction | Yes                        | Any active user, tedi, or verified external agent (`verifiedActiveWorkActor`).                    |
| Accept the specification                         | Yes, with `work:accept`    | `workItemAcceptanceActor`: owner/admin users unscoped; tedis and agents need `WORK_ACCEPT_SCOPE`. |
| Start, heartbeat, settle an Attempt              | Yes                        | Requires a tedi identity or verified external-agent session; a user cannot execute an Attempt.    |
| Complete the Work Item                           | Yes                        | Completion CAS only.                                                                              |
| Corroborate or contradict an outcome             | Yes                        | Any verified principal, once per principal, with an evidence ref.                                 |
| Propose an admission approval                    | Yes                        | User, tedi, or external agent.                                                                    |
| Decide an admission approval                     | Not an external agent      | Designated user or tedi; requester and decider must differ.                                       |
| Cancel a Work Item or replace its admission spec | No                         | Owner/admin user.                                                                                 |
| Write a resource pool or budget envelope         | No                         | Owner/admin user — an executor that can raise its own ceiling has no ceiling.                     |

`requireActivePrincipal` in
`packages/db/src/queries/work-items/factory-validation.ts` checks every
designated principal against the Work Item's organization; approvers never act
across organizations.

## Parallel execution

Genuinely parallel work uses distinct Work Items and Attempts. Waiting for
approval is a proposal, waiting for input is an interaction, and a model turn is
never held open as a lock. A shared directory is not by itself a conflicting
resource:

| Resource                                     | Coordination                                                          |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Disjoint files in separate worktrees         | Run in parallel.                                                      |
| A shared source file or inseparable contract | Exclusive `file:<repo>:<path>` key shared by every touching Attempt.  |
| A bounded feature spanning several files     | One `feature:<repo>:<name>` pool listing its files.                   |
| Same production surface or shared migration  | Build in parallel; one owner coordinates activation or the migration. |

## Control tower

The fleet control tower is a bounded derived projection, not a state machine.
It groups Attempts by state, readiness blockers, current admission rejections,
open interactions, approval age, and resource and budget pressure. Census
counters (`workItems.byDisposition`, `attempts.byRuntimeState`,
`attempts.staleLeases`) count every row; `attention` counters and the ordered
`attention.actions` triage queue count only actionable pressure. The queue
grants nothing; an empty queue does not mean every item is healthy.

## Failure rule

Do not repeat an unchanged failed plan. Read the Attempt, admission rejection,
interaction, settlement, and event stream; change the plan or open a typed
interaction. A conflict means recompute from current state, never bypass the
fence.

## Source map

- Persistence and invariants: `packages/db/src/schema/work-items.ts`,
  `packages/db/src/queries/work-items/` (`attempts.ts`, `admissions.ts`,
  `approvals.ts`, `admission-approval-policy.ts`, `readiness.ts`,
  `scheduler.ts`, `resources.ts`, `budgets.ts`, `interactions.ts`,
  `evidence.ts`, `fleet.ts`).
- Validation: `packages/api-contract/src/contracts/work-items.ts`,
  `packages/api-contract/src/schemas/work-items.ts`.
- API: `apps/api/src/rpc/routers/work-items/` and
  `apps/api/src/rpc/routers/work-approvals.ts` derive authenticated principals
  and map typed errors; they never trust actor input or build SQL.
- MCP tools use verb-first names and forward to the API. `tedix work` accepts
  `--input <json|@path>` for structured operations and keeps reads bounded.
- Tedix OS uses contract-derived query keys and exact-version mutations.

## Deliberately not implemented

- No writable universal status mixing portfolio, readiness, execution, and
  approval.
- No comments-as-approval, comments-as-response, or URL-as-completion parsing.
- No provider-native task, transcript, or manager context as source of truth;
  only admission grants execution.
- No Artifacts fork, branch, push, or repository status as execution authority
  or as a substitute for the canonical GitHub `main` ledger.
- No unbounded fleet/list read, client-side full-board scheduler, or capacity
  edit without a version fence.
- No all-to-all agent chat as a coordination substrate.
- No pre-proof gate, verifier, or required receipt without a real failure it
  would have caught.

## Related

- [Minimal gates over pre-proof](../decisions/minimal-gates-over-pre-proof.md)
- [Kernel execution model](kernel-execution-model.md)
