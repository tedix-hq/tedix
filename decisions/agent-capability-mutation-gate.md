---
summary: "ADR: capability and policy-tier mutations on a tedi are unreachable from agent-authenticated callers; gate the mutation class, not the request's origin"
read_when:
  - Adding a new mutation to tedi capability, permission or policy fields
  - Designing how a watcher or cron finding may act
  - Investigating why an agent-authenticated call to tedis.update was rejected
title: "Agent capability-mutation gate"
status: active
date: 2026-07-13
---

# ADR: Agent capability-mutation gate

**Status:** Active.

Scope: which tedi mutations an agent-authenticated caller may reach, and what
an autonomous finding (cron, watcher) is allowed to trigger.

## Context

A report-only watcher finding ("tedi A lacks a scope") can be read by a
routing model as an operator request, delegated to a privileged tedi, and
"fixed" by granting tedi A the broadest capability tier. Organization
membership alone authorizes cross-tedi updates
(`requireTediAccess`, `apps/api/src/rpc/routers/tedis/helpers.ts`), so a tedi
with high scopes can edit any peer's record.

Two fixes are tempting and both fail:

- **Classify the origin** ("was this a human request or a finding?"). That
  depends on a model correctly telling a report from a request — the judgment
  that fails.
- **Deny when the caller is proven to be a tedi.** Identity can be lost on the
  way: a call whose tedi header is dropped looks like a trusted internal
  service. In `apps/api/src/rpc/orpc.ts` a service-binding request without
  `X-Tedix-Tedi-Id` resolves to `authType: "service-binding"`, for which
  `hasRequiredScope()` returns true and `withPermission()` is bypassed. A
  denylist fails open.

## Decision

Gate the mutation class with an allowlist of caller types.

- Fields that carry lasting capability or spend —
  `AGENT_UNREACHABLE_CAPABILITY_FIELDS` in
  `apps/api/src/rpc/routers/tedis/crud.ts` (capability profile, tool policy,
  repo config, cron jobs, budgets, runtime profile and overrides) — may be
  changed only by a caller whose `authType` proves a human (`user`) or an
  operator-issued API key (`apikey`).
- Every other `authType` (`tedi`, `m2m`, `service`, `service-binding`,
  unresolved) is rejected, checked before any scope lookup, so a tedi's own
  elevated scopes cannot bypass it
  (`agentUnreachableCapabilityFieldsTouched`).
- `isUserToken()` (`packages/auth/src/jwt.ts`) must prove a human token
  affirmatively: a token with `client_id` and no `email` is a machine token.
  A `client_id` alone is not enough, because human OAuth logins through MCP
  clients also carry one.

The same doctrine covers the other self-modification paths:

- **Skill promotion** — the proposer never approves. `apply_skill_proposal`
  accepts a human, an API key, or a different tedi than the recorded author
  (`skill_entries.proposed_by_tedi_id`); anonymous machine credentials fail
  closed (`skillProposalApplyAuthority`,
  `apps/api/src/rpc/routers/cognitive-shared.ts`). The query layer asserts the
  same rule for forced promotions (`assertForcedSkillPromotionAuthority`,
  `packages/db/src/queries/skill-lifecycle.ts`).
- **Bulk memory admission** — `createFacts()`
  (`packages/db/src/queries/memory-graph/facts.ts`) rejects more than
  `BULK_FACT_ADMISSION_THRESHOLD` facts per call without operator authority.
  Single-fact learning stays ungated. Any bulk import must go through
  `createFacts()`.
- **Self-scheduling** — bounded, not gated. Scheduling follow-ups is a core
  runtime capability; the risk is runaway frequency. `cronScheduleCeilingError`
  and `resolveCronExpiry` (`apps/tedi-runtime/src/cron.ts`) enforce an interval
  floor, a job cap and a default expiry; policy packs can protect named crons
  from removal.
- **Delegation of findings** — approval-gated delegation
  (`apps/api/src/rpc/routers/kernel/delegation-dispatch.ts`) must not be
  auto-promoted for turns no human started. Do not add an environment switch
  that bypasses `needs_approval` without scoping it to human-initiated turns.

## Consequences

- A new tedi mutation endpoint asks "is this a lasting capability or policy
  change?" before "does this caller have the scope?". A tedi's scopes can be
  legitimately high; granting a different tedi a new tier is still not an
  action it should take unattended.
- API-side `withPermission` and scope middleware are not agent-facing controls.
  The MCP edge's per-tool scope map is the boundary
  (`toolToCapabilityScope`,
  `packages/api-contract/src/schemas/mcp-capability-scopes.ts`); a tool with no
  mapping is an error, not an open default.
- Audit rows name the acting tedi instead of a generic service actor
  (`apps/api/src/rpc/audit-helpers.ts`).
- Some fields remain agent-writable by choice (for example `personality`,
  installed skills, channels) so self-improvement keeps working. They are real
  self-modification surfaces.
- `governance.overview` (`apps/api/src/rpc/routers/governance.ts`) imports
  `AGENT_UNREACHABLE_CAPABILITY_FIELDS` so its decision-rights matrix cannot
  drift from the gate; change both together.

## Rejected alternatives

- **Origin classification** — relies on the model judgment that fails.
- **Tedi-detection denylist** — fails open when identity propagation drops.
- **A verifier tedi for every mutation** — adds a bureaucracy without removing
  the unsafe path.

Comparable agent frameworks converge on the same shape: automated approval is
capped to single-use decisions, permission levels change only through
authenticated human calls, and unattended contexts fail closed.
