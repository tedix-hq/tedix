Tedix 1.1.0 — opt-in turn-status reporter for local sessions.

The local artifact adds `hooks/agent_status.py`, a hook that records one status
line per Claude Code or Codex session at turn boundaries: working, needs you,
done, error or ended. It is off until the owner creates
`~/.tedix/agent-status.json` with `"enabled": true` or sets
`TEDIX_AGENT_STATUS=1`. It raises a local macOS notification only when a
session starts needing its owner or fails. With a named CLI profile it reports
the change through a detached `tedix code` call. It never prints, prompts,
blocks a turn or uploads a transcript; only a 160-character summary, the repo
and branch label, the host session ID and the state leave the machine.

Tedix 1.0.0 — first public release candidate.

Connect ChatGPT and Codex to authorized Tedix organizations through the shared
Tedix gateway. Bundled skills guide connection checks, scoped Work reads,
governed task handoff and Workspace Output workflows. Each operation remains
subject to the actual account grant and organization policy; installing a skill
does not enable writes or grant execution authority.

The public package uses one canonical Tedix identity, onboarding guidance and
light/dark brand assets. It contains no local lifecycle hooks, credentials or
copied tokens. The local artifact adds opt-in context hooks and an opt-in
decision-capture hook under the same plugin identity.
OpenAI supports combined MCP, skills and trusted hooks; local script execution
and CLI authentication remain host prerequisites, not cloud installation effects.

This initial candidate remains version 1.0.0 until submission. These release
notes describe the package, not a claim that public review, publication or the
reviewer validation has completed.
