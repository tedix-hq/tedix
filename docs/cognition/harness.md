---
summary: "The harness around each tedi: context, tools, rationale, memory, traces, evals, and promotion"
read_when:
  - Changing eval coverage or promotion behavior
  - Deciding whether a runtime capability is supported or experimental
  - Updating trace bundle or harness versioning behavior
title: "Harness"
---

# Harness

The harness is the stateful program around each tedi: context policy,
retrieval, skills, MCP tools, directives, rationale, artifacts, runtime events,
approvals, and eval feedback. Tedix improves workers by improving the harness,
not by exposing runtime choices to operators.

Every tedi runs the Agent runtime. Workstations are additive leases for
OS/process work and report results back into the same harness. The split
between the harness and the runtime substrates is owned by
[runtime.md § Runtime Boundary](runtime.md#runtime-boundary).

## Components

| Component        | Contract                                                                   | Primary paths                                                                         |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Context assembly | Select facts, directives, goals, work items, and recent results for a turn | `packages/context-core`, `apps/tedi-runtime/src/brain`, `apps/tedi-runtime/src/do.ts` |
| Tool surface     | Expose assigned MCP apps, tedi tools, Code Mode, and workstation tools     | `apps/mcp`, `apps/tedi-runtime/src/mcp-mount.ts`                                      |
| Rationale        | Record decisions, observations, outcomes, and promotion candidates         | `packages/context-core`, `packages/db/src/schema/rationale-records.ts`                |
| Memory           | Preserve customer-owned facts and retrieval records ([brain.md](brain.md)) | `packages/db/src/schema/memory-*.ts`                                                  |
| Trace bundle     | Persist selected run records, artifacts, and replay context                | `packages/api-contract/src/schemas/body-certification.ts`                             |
| Versioning       | Version harness components so a change can be compared and rolled back     | `packages/db/src/schema/harness-versions.ts`                                          |
| Evaluation       | Score kernel routes, runtime turns, tools, and harness candidates          | eval run/result tables                                                                |
| Promotion        | Decide when a directive, skill, policy, or runtime change can roll out     | harness eval rows, locked tests, approval policy                                      |

## What a claim needs

| Claim                          | Check                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| Runtime behavior works         | Focused tests plus a live smoke on the named runtime surface            |
| A workstation capability works | Tool result, process output, artifact readback, and trace linkage       |
| A memory or rationale change   | D1 readback plus the retrieval/decision record in the same trace        |
| A skill works                  | Skill run row, workflow status, artifacts, and policy/capability checks |
| A promotion is safe            | Locked eval result, rollback plan, approval state, and trace bundle     |

Unit tests are necessary but not sufficient for a production harness claim.

## Multi-trial evaluation reports

`HarnessEvalRun.report` is the optional structured evidence surface for an eval
runner that repeats the same task cohort. It requires at least two trials. Every
trial has a stable ordinal and seed, and all trials pin the same SHA-256 input
and settings digests. Retrying `recordEvalRun` with the same run id is accepted
only when the complete report is unchanged, so a replay cannot silently replace
the measured population.

Each model step records integer token counts, provider-billed cost in
micro-US-dollars, and zero or more named cache boundaries. A boundary reports
only tokens that were eligible for reuse from that exact stable prompt section
and how many were actually read from cache. The contract recalculates and
validates the run summary from those leaf observations, including cost totals,
mean cost, cache reads, and cache breaks per boundary and overall.

Do not infer a cache opportunity from the previous step's total prompt size.
That total includes new context and changes with run length, so its aggregate
"break rate" confounds cache behavior with how much work the trial performed.
Missing boundary observations remain missing evidence; they are not zeros.
Legacy eval runs remain valid with no report.

## Promotion

A promotion answers: which component changed, which tedi/org/surface it
affects, which evals cover it, what explains success or failure, how to roll it
back, and which policy gate approved it when one is required. Promote versioned
components with a rollback path, never opaque "it felt better" behavior.

## Related

- [runtime.md](runtime.md) — runtime contract and boundary
- [brain.md](brain.md), [skills.md](skills.md), [work-items.md](work-items.md)
- [../tedi/agent-runtime.md](../tedi/agent-runtime.md) — the Agent runtime
