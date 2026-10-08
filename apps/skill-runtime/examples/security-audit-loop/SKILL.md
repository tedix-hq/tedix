---
name: security-audit-loop
description: Bounded security-audit goal-loop. Dynamic threat modeling (Recon) → Hunt (claim-before-fileable) → authority-separated cross-pass adversarial Validation with a PoC-on-untouched-source oracle → gated patch proposals (never auto-applied). Funnel-metric output.
capabilities:
  network: false
  mcp:
    home:
      - ask
      - read_home_run
  rationale:
    mode: important
  expectedAnnotations:
    destructive: false
    readOnly: true
audience:
  - tedi
---

# security-audit-loop

A bounded, durable security-audit example with separate reconnaissance, hunting,
validation, and patch-proposal steps. It does not implement cross-repository
tracing, deduplication pools, or worker fan-out. Source:
[Cloudflare's vulnerability harness](https://blog.cloudflare.com/build-your-own-vulnerability-harness/).

## The loop (all durable Workflow steps)

1. **Recon — dynamic threat modeling.** Ask the kernel for up to `maxClasses`
   threat classes relevant to `target`. Repo-specific classes, not a fixed list.
2. **Hunt — claim-before-fileable.** Per class, the hunter must state (a) the
   threat model / attacker / boundary, (b) ONE concrete candidate finding, and
   (c) a proof-of-concept that would run against **untouched** source — or
   `NONE`. A candidate with no stated threat model or no PoC is not fileable.
3. **Validate — authority-separated cross-pass.** A separate adversarial pass
   that may **only judge, never file**. It tries to refute, and returns `REAL`
   only if the candidate has both a threat model AND a PoC-on-untouched-source;
   otherwise `REJECT`. The validator is a distinct turn; production validation
   should use a different model/provider.
4. **Patch — gated, never auto-applied.** For survivors, propose a minimal patch
   as a **proposal only**. Real remediation routes through `respond_home_approval`
   / `propose_tool_write`; this skill never mutates the target.

Enforced ceilings: `maxClasses`, `budgetUsd` (summed kernel cost), and a stall
guard. Output is a **funnel** (classes → candidates → survived → proposed
patches), never a recall claim.

## Usage

```
run_skill_workflow({ slug: "security-audit-loop", params: {
  target: "the apps/api kernel route-planner (apps/api/src/rpc/routers/kernel)",
  maxClasses: 4,
  budgetUsd: 0.50
} })
```

## Production escalation

For real repo hunting (compiling/running code, sandboxed PoC execution) the Hunt
step should delegate to a tedi on a **leased Cloudflare Sandbox workstation**
(see `decisions/workstations-over-bodies.md`) rather than a kernel reasoning turn — the kernel
pass here demonstrates the loop shape and the oracle/validation contract.
