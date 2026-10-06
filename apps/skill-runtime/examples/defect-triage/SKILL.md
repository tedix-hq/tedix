---
name: defect-triage
title: Phase-gated defect triage
description: Reproduce, diagnose, verify, and fix one reported defect through a durable Computer workflow. The verifier can stop the run as intended behavior or unclear before any fix command executes.
audience: ["tedi"]
capabilities:
  network: false
  reason:
    maxCalls: 3
  mcp:
    tedi: [open_computer, exec, read_execution, cancel_execution]
  expectedAnnotations:
    destructive: true
    readOnly: false
---

# Phase-gated defect triage

`./scripts/workflow.ts` runs four durable phases: Reproduce, Diagnose, Verify,
and Fix. The two diagnosis and verification reasoners have no tools or memory;
the verifier sees the original reproduction and expected behavior, not the
diagnosis. Its first line must be exactly `bug`, `intended_behavior`, or
`unclear`. Invalid or empty replies become `unclear`, and the Fix phase cannot
run for either early-exit result.

The caller provides `target`, `entityKey`, `revision`, `expectedBehavior`, and a
`reproduceCommand`. `fixCommand` is optional and is executed only after a
`bug` verdict; without it, the run reports a confirmed but unfixed defect.
Commands run in the selected Computer. Set `repository: true` only when the
target is the configured repository and the run has Work authority for edits.
Never pass credentials or secrets through workflow parameters or command text.

Admission is non-cancelling: when calling `run_skill_workflow`, use a stable
`idempotencyKey` of `defect-triage:<entityKey>:<revision>`. Repeating the same
request reuses its run. Start a new revision only after the prior run is
terminal; a new key is a new run, not a way to cancel an active one. The
workflow returns its `runId`, verdict, phase receipts, and any still-running
Computer `executionId` without claiming a fix from an unknown outcome.

Each Computer call is in a `step.do` with one total attempt. A long command's
`executionId` is observed with `read_execution` in separate durable steps;
the command is never replayed after an unknown result. Exhausting the bounded
observation window calls `cancel_execution` and exits as `unclear`. A `bug`
fix is checked by rerunning the original reproduction command; success is
reported only when that command exits zero.
