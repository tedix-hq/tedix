---
"@tedix/cli": patch
---

A Claude Code session an older CLI stored under a principal named for another harness (such as `codex-…`) no longer acts as that principal. It now resolves to a stable successor Agent-Session key (`claude-code:<uuid derived from the old key>`) under its own Claude principal, so `tedix agent start` and `tedix work start` work for it and its subagents without borrowing another harness's identity.
