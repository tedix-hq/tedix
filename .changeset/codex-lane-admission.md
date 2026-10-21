---
"@tedix/cli": patch
---

A Codex lane launched from a Claude Code shell (or Claude Code launched from Codex) now resolves its own session from the process tree instead of failing as ambiguous, so `agent status`, `work start` and `agent context` work without exporting `TEDIX_AGENT_SESSION` in every shell. `agent start` no longer requires `--model-version`: when the harness reports no dated snapshot it records `unpinned:<model>@<harness>/<version>`, and Codex's own `CODEX_VERSION` supplies the harness version.
