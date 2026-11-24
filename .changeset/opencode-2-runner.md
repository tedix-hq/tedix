---
"@tedix/cli": patch
---

Run tasks in OpenCode 2. Its local server moved to `/api/...`, `opencode run` no longer takes `--dir`, and session export is `opencode session export`, so every task start failed with a JSON parse error. OpenCode 1 is told to update.
