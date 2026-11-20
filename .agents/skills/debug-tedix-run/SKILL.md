---
name: debug-tedix-run
description: Diagnose a failed, stalled, or unexpectedly blocked Tedix agent run from a Work Item, run ID, or failure report.
---

# Debug a Tedix run

Use the Tedix session guide to resolve the Work Item and authorized evidence.
Read [the agent guide](../../../docs/public/agent-guide.md) for the relevant
executor. For an already admitted Work Item, keep its existing executor,
Attempt, and lease.

1. Identify the run and its current state. Record the revision, executor,
   provider and model when relevant, and the first useful failure timestamp.
   Check whether a newer Attempt or deployed fix already addresses the report.
2. Locate the first point where the run diverged from what was expected.
   Follow only the relevant handoff, such as admission to launch, provider
   request to response, tool selection to execution, or result to settlement.
   Compare actual run evidence with configured intent.
3. Read the narrowest useful logs or events with the authorized connection.
   For a local dispatcher that rejected commit evidence, start with the
   `custody-rejected` entry in its dispatcher log. Keep credentials, customer
   data, and private trace contents out of public output.
4. Reproduce with the same inputs and effective configuration. Change one
   factor when testing a hypothesis. If the task authorizes a fix, repair the
   owning boundary and rerun the same probe.

Report the first confirmed failure, the evidence for it, and the result of
the rerun. Record any unavailable evidence and who owns a genuine dependency
or approval.

Adapted from [OpenClaw's debugging skill](https://github.com/openclaw/openclaw/blob/c8931b32d3d/.agents/skills/openclaw-debugging/SKILL.md).
