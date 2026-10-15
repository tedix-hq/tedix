---
"@tedix/cli": patch
---

Codex started from a Claude Code shell keeps its own `codex:<thread>` Agent-Session. `agent status`, `agent finish` and `tedix work` labelled that thread `claude-code:` because the shell carried `CLAUDECODE`, so they missed the session `agent start` had opened.
