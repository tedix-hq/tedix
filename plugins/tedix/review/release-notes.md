Tedix 1.0.0 — first public release candidate.

Connect ChatGPT and Codex to authorized Tedix organizations through the shared
Tedix gateway. Bundled skills guide connection checks, scoped Work reads,
governed task handoff and Workspace Output workflows. Each operation remains
subject to the actual account grant and organization policy; installing a skill
does not enable writes or grant execution authority.

The public package uses one canonical Tedix identity, onboarding guidance and
light/dark brand assets. It contains no local lifecycle hooks, credentials or
copied tokens. The local artifact adds opt-in, read-only hooks under the same plugin identity.
OpenAI supports combined MCP, skills and trusted hooks; local script execution
and CLI authentication remain host prerequisites, not cloud installation effects.

This initial candidate remains version 1.0.0 until submission. These release
notes describe the package, not a claim that public review, publication or the
reviewer validation has completed.
