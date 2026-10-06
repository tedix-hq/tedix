---
status: accepted
date: 2026-09-12
summary: "Keep durable Tedi identity separate from task-scoped Computer execution capacity"
read_when:
  - Choosing ownership boundaries between a Tedi and its Linux environment
  - Designing Computer lifecycle or workstation admission
title: "Tedi identity and Computer execution"
---

# Tedi identity and Computer execution

A Tedi owns identity, memory, reasoning, policy and the conversation. Its
Computer supplies files and execution. Full Linux capacity is an optional,
task-scoped workstation lease, not another cognitive runtime.

## Decision

Expose one small Computer interface to the agent: open, file operations,
execute, observe, cancel and close. Keep lease admission, participants,
credentials, repository preparation and lifecycle control in the host. The
agent chooses a clean shell or the configured repository when opening. Once
selected, file tools and commands use the same filesystem.

Use the Agent runtime for cognition. Use Cloudflare Computer for workspace and
command execution, with the workstation adapter (`apps/tedi-workstation-runtime`)
supplying Linux processes. A lease does not own Tedi memory or customer state.
Container disk can disappear on replacement, so publish lasting outputs through
repository commits, Artifacts and the runtime event ledger.

## Consequences

- Swapping or losing a workstation never loses cognitive state.
- Workstation admission and credentials stay a host concern; the agent sees
  only the Computer interface.

The runtime side of this contract lives in
[Agent runtime](../tedi/agent-runtime.md).
