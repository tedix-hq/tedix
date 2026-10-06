---
summary: "Accepted ADR: one thin singular kernel over specialized owned planes over the tedi fleet — not a memory/actions/attention/learning kernel quartet"
read_when:
  - Deciding whether Tedix should have one kernel or multiple peer kernels
  - Assigning ownership of a cognitive domain (memory, skills, errors, self-improvement)
  - Wiring couplings between decisions, execution, skills and objectives
  - Tempted to add a memory/learning/attention kernel or a verifier-tedi layer
title: "Agentic kernel architecture: thin kernel + planes + fleet"
status: accepted
date: 2026-07-16
---

# ADR: Agentic kernel architecture — thin kernel + planes + fleet

**Status:** Accepted.

Scope: what a kernel is in an agentic OS, how many exist, which layer owns each
cognitive domain, and how cross-domain couplings are enforced without adding a
peer kernel.

## Decision

Tedix keeps one thin, singular kernel and pushes specialization down, not
sideways. Three layers:

1. **Kernel** — one organization-scoped, identity-less, non-blocking control
   plane. It owns coordination-shaped domains only: orchestration, synthesis and
   coordination-as-governance. It is the scheduler, not the process.
2. **Planes** — specialized owned control surfaces below the kernel (memory,
   work/action, learning, attention/context, knowledge). Each has a named owner,
   a hard write-path rejection at its boundary, a recorded execution stamp and
   its own schedule. Planes are neither passive stores nor peer kernels, and they
   hold no decision authority.
3. **Fleet** — the tedis, each an Agent-runtime Durable Object, where memory,
   actions, attention and learning run per worker, and where self-improvement's
   proposer ≠ approver separation lives.

A memory / actions / attention / learning kernel quartet is rejected. Those
would be four in-loop cognitive processes, each a decision-maker.

## What a kernel is

The kernel is the organization-scoped, identity-less, non-blocking control plane
that schedules and routes. It:

- owns the process table: one human turn becomes one `homeRunId` that fans out
  into branches;
- picks exactly one of a closed set of typed routes per turn;
- dispatches work to other Durable Objects (tedis) and returns immediately;
- reconciles their terminal events through an inbox and wake alarm, not polling;
- synthesizes results back into one linear conversation.

It must not have a free tool loop, a `tediId` (`subject_kind='kernel'`), memory
writes, a skills engine, or an free in-loop agent. It keeps track of many
concurrent work streams because it never does the cognitive work itself. See
[Kernel execution model](../cognition/kernel-execution-model.md).

The kernel is singular by definition. Where a proposed "kernel" holds state and
cadence it is a plane; where it needs an identity it is a tedi.

## Ownership

| Domain                         | Owner                                                                                                  | Layer           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------- |
| Orchestration (delegation)     | Kernel/Home — `apps/api/src/workflows/kernel-goal-loop-workflow.ts`, one facet per conversation        | Kernel          |
| Synthesis                      | Kernel/Home — child results rendered as prose, graded mechanically                                     | Kernel          |
| Coordination-as-governance     | Kernel — proposer ≠ approver keyed on `context.tediId`                                                 | Kernel          |
| Memory (facts)                 | Brain — D1 facts, `apps/tedi-runtime/src/brain`, admission and disposal                                | Memory plane    |
| Tasks (work items)             | Work-item ledger and `mcp_tasks`                                                                       | Work plane      |
| Skills                         | Skill rows, proposal/apply lifecycle, promotion candidates                                             | Learning plane  |
| Context (assembly, compaction) | `packages/context-core` and consolidation/reflection jobs                                              | Attention plane |
| Rationale                      | Rationale records linking observations, facts, decisions and outcomes                                  | Knowledge plane |
| Errors and recovery            | Split by cadence: kernel handles per-turn recovery; learning plane records failures on skills          | Cross-cutting   |
| Resources (budgets, compute)   | Policy packs, cron ceilings, runtime profiles and the cost ledger per tedi                             | Cross-cutting   |
| Self-improvement               | No single owner by design: planes own their contracts, the fleet supplies separate approver identities | Composition     |

Learning is one organization-scoped plane, not per-tedi learning kernels:
executable skills are organization-scoped rows, so the learning plane queries
organization-wide while decisions stay per tedi.

## Couplings are plane-boundary contracts

Failures in agent systems cluster at the seams between components, not inside
them. Each coupling is one synchronous admission check at the receiving plane:

- **Decision ↔ execution** — a rationale record without an execution link
  (`runId`, `workItemId` or `toolCallRefs`) is rejected with
  `UNLINKED_RATIONALE` (`packages/db/src/queries/rationale-records.ts`).
- **Trace ↔ skill** — skills are induced from executed trajectories and promote
  only on verified runs; failed runs increment the skill's failure count with the
  failing `runId`.
- **Gate ↔ objective** — standing objectives carry a gate configuration, so
  autonomy grows only after verified successes (`processGateGraduation`,
  `packages/db/src/queries/tedi-objectives.ts`).
- **Memory disposal** — the memory plane owns admission and consolidation,
  eviction and archival, on its own slower schedule.
- **Scheduled cognitive jobs** — every job records a stamp and a diffable
  promote/demote/merge/archive transition; no stamp means it did not happen.

Under four peer kernels each of these would be a cross-kernel distributed
transaction. At a plane boundary it is one rejection.

## Why this shape

- Coupling, not splitting, is what makes the system improve: wiring existing
  machinery together beats adding subsystems.
- Safe self-improvement needs separated identities, and the fleet plus humans
  already provide them. A peer learning kernel that approves is a verifier
  bureaucracy, not separation.
- One thin kernel produces one append-only transcript, which is what users of
  Claude Code, Codex and ChatGPT expect: inline tool and route calls, a
  work-card checklist, collapsible sub-agent rows showing synthesized summaries,
  and resumable sessions. Planes and the fleet surface only as activity rows and
  work cards inside that thread. Peer kernels would fragment it.

Reliability comes from:

- completion only on proof — silence is never completion;
- persisting the `homeRunId` before calling the Durable Object;
- non-blocking dispatch, so concurrency does not time-slice the loop;
- mechanical conformance grading, with no model verdicts in the loop;
- hard write-path rejections at plane boundaries.

## Invariants

1. The kernel is singular and thin: no Pi loop, no `tediId`, no memory
   writes, no skills engine.
2. Planes hold no decision authority. A plane runs mechanical or
   policy-as-data transitions, never a model-verdict loop; one that grows one
   has become a shadow kernel.
3. Slow planes (consolidation, learning) get protected budget and schedule, not
   leftover capacity from fast routing; otherwise adaptation starves.
4. Plane-to-plane contracts go through the shared store (D1), never private
   channels, and delegation chains stay short.
5. Fleet fan-out is for independent, read-heavy work. Writes and decisions stay
   single-threaded through the kernel.
6. Verification is structural (linked records, mechanical checks), not a
   verifier agent.
7. Each tedi carries its own full control loop — local control, reflection,
   adaptation and identity — so "below the kernel" never means subordinated.

## Rejected alternatives

- **Decomposed multi-kernels** (memory / actions / attention / learning) —
  multiplies decision authority and turns every coupling into a cross-kernel
  transaction.
- **A unified kernel with passive subsystems** — leaves handoffs unowned, and
  slow work such as consolidation and disposal starves behind fast routing.
- **A verifier-tedi or approver-kernel** — identity separation already comes
  from distinct tedis and humans.

## Grounding

- CoALA (Sumers et al., 2023): memory and learning are modules under one
  decision procedure. <https://arxiv.org/abs/2309.02427>
- MemGPT (Packer et al., 2023): one loop paging a tiered memory — a data plane,
  not a memory kernel. <https://arxiv.org/abs/2310.08560>
- Generative Agents, A-MEM, Reflexion: retrieval, evolving memory and reflection
  inside one agent. <https://arxiv.org/abs/2304.03442>,
  <https://arxiv.org/abs/2502.12110>, <https://arxiv.org/abs/2303.11366>
- MAST (Cemri et al., 2025): multi-agent failures cluster in inter-agent
  misalignment. <https://arxiv.org/abs/2503.13657>
- Cognition, "Don't Build Multi-Agents" (2025): unify decision authority.
  <https://cognition.ai/blog/dont-build-multi-agents>
- MetaGPT (Hong et al., 2023): decomposition survives only with a shared
  blackboard and typed schemas. <https://arxiv.org/abs/2308.00352>
- Anthropic, multi-agent research system (2025): orchestrator plus stateless
  workers, suited to independent parallel reads.
  <https://www.anthropic.com/engineering/multi-agent-research-system>
- Beer's Viable System Model: distribute function, keep one identity per
  recursion level, and actively protect the adaptation function — the source of
  invariants 3 and 7.
- Mintzberg, _The Structuring of Organizations_: support functions standardize
  work but hold no line authority — the source of invariant 2.

## Related

- [Kernel execution model](../cognition/kernel-execution-model.md)
- [Brain](../cognition/brain.md)
- [Skills](../cognition/skills.md)
- [Work items](../cognition/work-items.md)
