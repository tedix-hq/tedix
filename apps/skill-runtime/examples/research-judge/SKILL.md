---
name: research-judge
description: Judge every opened research thread in bounded batches, splitting unavailable or incomplete responses.
capabilities:
  network: false
  mcp:
    tedi: [run_tedi_turn]
---

# Research judge

Pass `threads: [{ id, excerpt }]`, with the research question included in each
excerpt. This example accepts at most 24 threads, 200 characters per ID, and
3000 characters per excerpt. Other input fields are excluded from the prompt.
It judges three threads per call, in isolated tool-free synthesis sessions.

The MCP bridge retries a lost acknowledgement once using the same request ID.
If that recovery fails, the workflow splits the missing threads into smaller
calls, down to one thread. Partial replies preserve valid judgments and split
only the missing IDs. Each call has a durable step and a distinct request ID;
engine retries cannot silently dispatch a different request for that step.
Pending synthesis turns are observed with the same request ID in separate
steps, with twelve ten-second sleeps before giving up and splitting.

The result includes one verdict per opened thread in input order. An unresolved
singleton fails with `JUDGE_INCOMPLETE` and its ID; saved step outputs retain the
judgments already obtained. Callers must require complete judgment before
producing a report or card. Never use this split pattern for actions with
external effects: the original call may still be running.
