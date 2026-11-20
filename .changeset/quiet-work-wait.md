---
"@tedix/cli": patch
---

Add `tedix work wait <id>` to block until a task has a new comment, run message, answer or lifecycle event. Returns a continuation cursor and an explicit timeout reason; use `--input` to set `timeoutMs` or pass the previous `cursor`.
