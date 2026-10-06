---
name: kernel-goal-loop
description: Durable, resumable reference L2 goal-loop for deterministic or adversarial text evaluation, persisting every turn as a durable Workflow step. Objective Work Item evaluation belongs to the first-class kernel goal-loop Workflow.
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
    readOnly: false
audience:
  - tedi
---

# kernel-goal-loop

The durable form of the **L2 goal-loop** primitive: a maker turn repeats until a
separate evaluator says the goal is met or a bound is hit. Where the `kernel_goal_loop` Code Mode
muscle polls inside a single ~30s isolate, this skill runs the same governed
loop as a **Cloudflare Workflow**: each kernel turn, poll, and inter-turn wait is
a durable `step.do` / `step.sleep`, so the loop survives DO hibernation, retries
per step, and is observable through the run timeline + artifacts.

## What it does

Each iteration (up to `maxTurns`):

1. `step.do` — submit a kernel turn via `home.ask({ content })` (the
   maker — makes progress on the goal every turn, regardless of evaluator).
2. `step.do` + `step.sleep` — poll `home.read_home_run` until the run is
   terminal, extracting only the small route/cost fields (the large run-set
   payload never lands in a persisted step value).
3. **Separate-evaluator stop-check** (checker ≠ maker):
   - `deterministic` — a regex the maker prompt never sees, tested against
     the maker's answer.
   - `adversarial` — a second `ask` judge turn that may only rule
     DONE/CONTINUE and is forbidden from answering the task.
4. Enforced ceilings — stop on `condition_met`, `budget_exceeded`
   (summed `bodyExecutionResult` cost > `budgetUsd`), `stall` (>2), or
   `max_turns`.

`work_items` is deliberately rejected here. Use the first-class kernel
goal-loop Workflow (`tedix goal --evaluator work_items --objective-id ...`),
which owns the single-statement D1 completion oracle. A paginated skill-side
copy cannot provide the same snapshot or historical-checkout guarantees.

## Usage

```
// deterministic / adversarial (unchanged)
run_skill_workflow({ slug: "kernel-goal-loop", params: {
  content: "In one sentence, define loop engineering.",
  condition: "loop",
  maxTurns: 3,
  budgetUsd: 0.10,
  evaluator: "deterministic"      // or "adversarial"
} })
```

Params: `content` (required), `condition` (required), `maxTurns` (default 3),
`budgetUsd` (default 0.10), `evaluator` (`deterministic` | `adversarial`),
`pollAttempts` (default 18), `sleepSeconds` (default 3).

## Output

`{ met, stop, turns, totalCostUsd, evidence[] }` where each evidence row carries
`runId`, `status`, `routeKind`, `routerVersion`, `harnessVersionId`,
`traceBundleId`, `costUsd`, `verdict`, and the answer preview for that turn. The
durable step timeline (`get_skill_workflow_status` →
`engine`, `list_skill_run_artifacts`) proves the per-turn `step.do` /
`step.sleep` checkpoints.
