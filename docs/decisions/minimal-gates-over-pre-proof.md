---
summary: "ADR: a check earns its place only after a real failure it would have caught; detect-and-correct beats prevent-by-proof; the cheapest way to make a gate green must never be to lower it"
read_when:
  - Proposing a new gate, verifier, reviewer, certification, or required receipt
  - Wondering why settling a Work Item completes it without an evidence count or review
  - Deciding whether a claim needs pre-proof or can be corrected when someone notices
  - Finding legacy acceptance-contract fields (`claims`, `evidenceKinds`, `requiresIndependentReview`) that no gate reads
title: "Minimal gates over pre-proof"
status: accepted
date: 2026-09-07
---

# ADR: Minimal gates over pre-proof

**Status:** Accepted and implemented. Settlement records the outcome; completion
does not wait on an evidence review.

Scope: every mechanism that requires proof _before_ an action is permitted —
build checks, acceptance contracts, evidence kinds, independent review, readback
verifiers, certification workflows.

## Context

Validation should test concrete behavior. Evidence counts and rigid receipt
formats add friction without independently establishing that an outcome is true.

Checks that can be satisfied more cheaply than the behavior they represent
encourage fabricated inputs. Passing validation proves only the behavior
exercised by the check; accepted evidence does not independently establish a
claim's truth.

## Decision

1. **A check earns its place only after a real failure it would have caught.**
   A specific incident, not a plausible class of failure. Add such a check as
   its own stated change, never bundled into the work it would have blocked.
2. **Prefer detect-and-correct to prevent-by-proof.** Let the action happen and
   make a wrong outcome cheap to notice and cheap to reverse. Pre-proof is
   justified only where correction is impossible or ruinous (the list below).
3. **The cheapest way to make a gate green must never be to lower it.** This is
   a design constraint on the gate. If weakening, re-rolling, or hand-typing a
   check's input is easier than doing the work it stands for, delete the check
   or make the honest path cheaper.
4. **Size and count ceilings are diagnostics, not gates.** Bundle bytes,
   source-line totals, lint-warning counts, and query-call counts are reported,
   not blocking. Concrete correctness checks stay: lazy-import boundaries, type
   errors, behavioral tests, storage ownership, authorization, migration safety.
5. **For coding work, the commit is the record.** The pre-push hook
   (`.githooks/pre-push` → `scripts/ci/preflight-gates.mjs`) runs the tests
   related to the changed files. Demanding a separate receipt that re-proves
   the tests ran re-implements a validation stage.
6. **Settled means done.** A Work Item is accepted with a plain-language "done
   looks like"; an Attempt settles with an outcome, a summary, and its commit
   shas; completion carries no evidence count and no review requirement. Legacy
   acceptance-contract fields stay parseable so existing items deserialize, but
   nothing consults them. A wrong claim is corrected when noticed: a second
   principal records a contradiction in `work_item_corroborations`
   (`packages/db/src/schema/work-items.ts`).
7. **A record earns its place only if something reads it.** Retiring a gate
   does not retire its tables, verbs, flags, and prose. When a plane stops being
   enforced, say what still reads it and what breaks if nothing writes it, then
   delete what survives neither test. Zero rows is not proof of dead code: read
   the callers before deleting.

## Where pre-proof stays

Removing pre-proof from _claims_ does not remove it from _authority_. These
survive because correction after the fact is impossible:

- **Admission approval for irreversible work.** Required authorities plus risk
  level produce the `approval_blocked` admission blocker
  (`packages/db/src/queries/work-items/admission-approval-policy.ts`). This is
  an independent decision at _admission_, not completion. The approver may be a
  person or an independent agent principal; explicitly human-reserved decisions
  stay with a human.
- **Execution fences and concurrency CAS.** Attempt-owned writes derive
  `orgId`/`workItemId` from the `work_attempts` row, not the caller, and
  completion is a compare-and-swap with a no-active-attempt predicate
  (`packages/db/src/queries/work-items/crud.ts`). An expired executor writing to
  another agent's item is not a claim anyone can correct later.
- **Migration ordering on deploy.** Code must not reach production ahead of the
  schema it needs; a database migrated past its code is not correctable in
  minutes.

## Consequences

- **Nothing re-reads a live surface after an agent claims it works.** An agent
  can settle "deployed" for code that never reached the edge. The mitigation is
  cheap checkability, not a gate: every Worker version is stamped with its
  commit, so anyone who doubts a claim can check it.
- **Live-only claims need live verification.** A commit SHA cannot establish
  that a widget renders in Safari. Anyone checking that claim must test the
  deployed widget on the named browser.
- **Structured rejection recovery codes disappear.** Some of them could never be
  satisfied by the executor that received them, so they fed retry loops.
- **Git becomes the ledger for coding work.** Commits link the implementation
  to its Work Item; the recorded outcome remains separately checkable.

## Applying this to the next system

Before adding any gate, verifier, required receipt, or certification, answer in
writing:

1. **Which real incident would this have caught?** No incident, no gate.
2. **What is the cheapest way to make it green?** If that is anything other than
   doing the work correctly, revise the check or make the honest path cheaper.
3. **If the claim is wrong and nothing catches it, what does it cost and how
   soon will someone notice?** Cheap and soon means detect-and-correct.
   Irreversible means admission approval, the mechanism above. Check that the
   correction path you rely on is actually used.
4. **Can the principal you demand proof from actually produce it?** Walk the
   executor's real capabilities. A contract that demands what the runtime
   forbids fails every time.

## Rejected alternatives

- **Keep the evidence plane and tune it.** The binding checks carried the
  friction without sufficient detection to justify them.
- **Run old rules until in-flight items drain.** Keeps the reviewer plane alive
  and creates inconsistent completion rules on one board.

## Revisit trigger

A specific production failure that a specific pre-proof check would have caught,
where correction was impossible or cost more than the check. One such incident
earns one such check, scoped to that failure.

## Related

- [Work Items](../cognition/work-items.md)
