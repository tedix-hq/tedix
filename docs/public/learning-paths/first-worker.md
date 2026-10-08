---
sidebar:
  order: 10
title: "Run a digital worker and find its result"
topic: "Learning paths"
resource_type: tutorial
description: "Run one existing Tedix digital worker, find its result, and inspect the run evidence."
summary: "A first useful worker result with prerequisites, expected output, evidence, and recovery"
read_when:
  - Running a Tedix digital worker for the first time
  - Checking whether a task reached a worker
  - Recovering a first worker run that did not finish
visibility: public
---

# Run a digital worker and find its result

This tutorial gives one named digital worker, called a **tedi**, a small task.
It uses only the facts in the prompt, so it needs no connected app, private
document, or permission to change an outside system.

This is a Tedix Cloud tutorial; [Release status](../release-status.md) says who
can use Cloud today. The local product does not run remote tedis; use the
[local path](../getting-started.md#run-tedix-locally) to evaluate local storage
and the user interface instead.

## Before you start

You need:

- membership in a Tedix Cloud organization;
- a completed [first Cloud connection](./first-connection.md);
- at least one active tedi in the organization; and
- the tedi's slug, shown with the worker in Tedix OS.

Check the CLI connection before sending work:

```bash
tedix -w acme auth status
```

Replace `acme` with your saved CLI profile. The output must name the intended
organization and its gateway. If the organization or gateway is wrong, stop
and sign in to the right organization with `tedix login ORG_SLUG`.

## Give the worker one task

Replace `WORKER_SLUG` with the slug of an active tedi, then run:

```bash
tedix -w acme tedi WORKER_SLUG ask \
  "Review this supplier brief: three recent orders arrived 4, 6, and 9 days late. Support replied within 1 business day twice and after 4 business days once. The unit price is EUR 18 and our limit is EUR 20. Give one recommendation, three evidence bullets using only these facts, and two follow-up questions. Do not call tools, create files, or contact anyone."
```

The command targets that worker directly and waits for the run. Keep the Home
run ID printed by the CLI; you will inspect it next.

## Check the answer

A useful answer has all of these:

- one clear recommendation;
- three evidence bullets grounded in the supplied numbers;
- two follow-up questions;
- no invented supplier facts; and
- no claim that a tool, file, or outside action was used.

Wording can differ. A completed run records what the worker reported; it does
not prove that the recommendation is correct.

## Inspect the run

Read the run after it finishes:

```bash
tedix -w acme inspect HOME_RUN_ID --events --artifacts
```

Replace `HOME_RUN_ID` with the ID printed by the task command. Check that the
inspection names the selected tedi and includes its child run. The events should
end in a completed state. This task should have no tool-created artifacts
because the prompt forbids tool calls and file creation.

You have a first useful worker result when both conditions hold:

1. the answer meets the checklist above; and
2. the inspection shows that the named tedi produced it.

A Home-only answer, a queued task, or a run ID by itself is not a worker result.

## If it does not work

Start with the symptom you see.

### `Tedi not found`

The slug is wrong or belongs to another organization. Check the selected
organization with `tedix -w acme auth status`, then copy the worker slug again
from Tedix OS. Do not substitute a display name.

### The CLI exits with code 3 or loses its connection

Exit code 3 means the server run is still active after the CLI stops waiting. A
lost connection can leave the run active too. Do not submit the task again.
Read the existing run instead:

```bash
tedix -w acme run HOME_RUN_ID
tedix -w acme inspect HOME_RUN_ID --events --artifacts
tedix -w acme tail HOME_RUN_ID --no-follow
```

The last command reads the events available now. Omit `--no-follow` to keep
watching until the run settles. Use the status printed by `run`; a successful
read exits with code 0 even when the recorded run itself failed. Keep using the
same Home run ID until the status is completed, failed, or canceled.

### The run is waiting for approval

Read the pending action before deciding:

```bash
tedix -w acme status
tedix -w acme inspect HOME_RUN_ID
```

Compare the inspected proposal with the tutorial prompt. If it delegates only
the supplier-brief review to the selected tedi and preserves the ban on tools,
files, and outside contact, approve that exact scope:

```bash
tedix -w acme approve HOME_RUN_ID "supplier-brief review only; no tools, files, or outside contact"
```

If the target, task, or permitted actions differ from that scope, reject it:

```bash
tedix -w acme reject HOME_RUN_ID "does not match the supplier-brief review scope"
```

Inspect the run again after either decision to confirm its status.

### You need to stop an active run

Cancel only a run that is still active and no longer needed:

```bash
tedix -w acme cancel HOME_RUN_ID "first-worker run is no longer needed"
tedix -w acme inspect HOME_RUN_ID --events
```

The cancel command requests a stop and reports the delegated child-stop outcome
when one is available. Use the inspection to confirm the terminal status. Do
not use cancellation to recover a run that has already failed.

### The run failed and offers recovery

Capture its evidence before retrying:

```bash
tedix -w acme inspect HOME_RUN_ID --events --artifacts
tedix -w acme tail HOME_RUN_ID --no-follow
```

Keep the Home run ID, named tedi, child run ID, final status, Work Item ID, and
visible error. Retry only when the failed-run output explicitly says
`Recovery available` and supplies a Work Item ID:

```bash
tedix -w acme retry WORK_ITEM_ID
```

This retry applies only to that blocked delegated Work Item. It sends the same
work to the same tedi under a new child attempt and keeps the same Home run ID.
The server decides whether the retry runs. If the server accepts the retry,
inspect the same Home run again:

```bash
tedix -w acme inspect HOME_RUN_ID --events --artifacts
```

The inspection should show the new child run and its current status; repeat it
until that run is terminal. If the server refuses the retry for any reason,
including an ineligible Work Item or a reached retry limit, stop. Do not create
a replacement task automatically. Do not use `retry` for a failed Home run
that did not offer this recovery.

### The run failed without offering recovery

No retryable Work Item ID is available from this run. Use the inspection and
event snapshot above to identify an input, worker, permission, or connection
problem. Stop rather than automatically submitting a replacement task.
Preserve the evidence and use the support path below.

### The run completed but the answer is incomplete or wrong

A completed status records what the worker reported; it does not make the
answer correct. Do not use `retry` unless the CLI offered recovery for a failed
delegation. Compare the answer with the checklist above, make the missing or
incorrect requirement explicit in one corrected bounded prompt, and submit it
only after the first run is terminal. Keep the old and new Home run IDs.

### The inspection does not name a tedi

That is not a successful result for this tutorial. Confirm that you used
`tedix tedi WORKER_SLUG ask`, rather than a plain `tedix ask`, and inspect the
same run ID printed by that command.

### You still cannot recover the run

Follow the [support terms for your Tedix surface](../self-hosted-boundary.md#support).

For managed Tedix Cloud beta, use the authorized support route in the
customer's agreement. Through that private route, provide the CLI version,
selected organization and gateway, exact command, Home run ID, tedi and child
run IDs, Work Item ID when shown, final status, event timestamp, and visible
error. Redact OAuth grants, browser cookies, API keys, and unrelated private
organization content.

For public `main` or local mode, issues are welcome without a response-time
guarantee. Include the CLI version, command shape with placeholders, final
status, and sanitized error text. Do not publish the CLI profile, organization
or tenant gateway, tedi slug or ID, Home or child run IDs, Work Item ID, event
payloads, credentials, or private organization content. Self-hosted
installations are experimental and unsupported.

## Next

- Learn [what a worker owns and what Tedix records](../workers-and-governance.md).
- Learn when to use Home, workers, or flows in [Skills, automations, flows, and
  runs](../skills-flows-workflows.md).
- Read the [agent guide](../agent-guide.md) before an external coding or
  research agent operates an organization.
