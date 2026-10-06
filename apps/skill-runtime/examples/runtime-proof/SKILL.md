---
name: workflow-kitchen-sink
description: Canonical production certification fixture for deterministic and dynamic steps, parallelism, retries, permanent failures, timeouts, sensitive evidence, sleeps, events, lifecycle controls, rollback, MCP identity, hosted artifacts, autonomous Firecrawl research, and a real tedi-in-the-loop turn.
capabilities:
  network: true
  mcp:
    home:
      - read_home_run_set
    cognitive:
      - record_artifact
    tedi:
      - run_tedi_turn
    firecrawl_tedix:
      - firecrawl_agent
      - firecrawl_agent_status
  rationale:
    mode: important
  schedule:
    cron: "0 0 1 1 *"
    params:
      mode: retry
    enabled: false
  reliability:
    parameter: mode
    expectedTerminalStatuses:
      nonretryable: failed
      sensitive-error: failed
      timeout: failed
      floated-failure: failed
      rollback: canceled
  expectedAnnotations:
    destructive: false
    readOnly: false
audience:
  - tedi
---

# Workflow Kitchen Sink

This tedi-scoped fixture validates the executable-skill runtime without making
external mutations. Invoke it with one of these modes:

- `retry`: fails two ordinary-error attempts, then succeeds.
- `nonretryable`: throws Cloudflare's native `NonRetryableError` from a step
  configured with retries; the engine must execute only one attempt.
- `sensitive`: returns a marker from a step configured with
  `sensitive: "output"`; Tedix evidence must contain only a redaction marker.
- `sensitive-error`: throws a marker-bearing `NonRetryableError` from a
  sensitive step; the engine must execute exactly one attempt and every
  persisted and engine-facing failure surface must contain only the sanitized
  error code.
- `sleep`: exercises `step.sleep` and `step.sleepUntil`.
- `mcp`: performs one safe Home read so the MCP call/idempotency receipt can be
  inspected.
- `network`: proves an aliased fetch outside `step.do` is blocked by the runtime
  gate while a HEAD request inside `step.do` reaches `example.com`.
- `isolation`: attacks inherited fetch/WebSocket/EventSource/beacon globals,
  Cache, run-context mutation, MCP outside step context, and primordial
  monkey-patching; every exercised authority boundary must remain closed.
- `buffered-response`: retains an HTTP Response across a step boundary and
  reads it afterward, proving the network body was materialized before the
  tracked operation closed.
- `path`: runs dot, dot-dot, embedded-dot, and ordinary step names so their
  URL-stable receipt components can be inspected and filtered.
- `floated-failure`: starts but deliberately does not await an invalid fetch;
  the native step must fail instead of caching the callback's false success.
- `approval`: waits for the canonical `approval` event and verifies both its
  audited reason and caller-supplied custom metadata.
- `rollback`: registers a rollback handler, then waits. Cancel the run with
  `rollback: true` to prove native reverse compensation and rollback evidence.
- `parallel`: executes and joins two independent durable steps.
- `dynamic`: creates a bounded deterministic step sequence from `params.items`.
- `timeout`: exceeds a one-second native step timeout and must fail once.
- `artifact`: publishes a hosted artifact without accepting a caller-supplied
  `tediId`; the runtime injects ownership from the admitted run snapshot.
- `tedi`: runs a real owning-tedi interpretation turn and asserts the exact
  requested response marker.
- `research`: uses the quality-preferred `firecrawl_agent`, then patiently polls
  `firecrawl_agent_status` to a terminal result in a separate durable step.
- `lifecycle`: waits for `certification-finish`; the certifier pauses, resumes,
  and then sends that event.

Successful correctness scenarios return a `certification` envelope containing
declared assertions. This is deliberately separate from the engine's terminal
status and from `get_skill_workflow_reliability`: a completed run can still fail
its declared business assertions. The fixture intentionally returns only small,
non-secret values. Artifact and research modes make bounded production writes;
the tedi mode incurs one real model turn.
