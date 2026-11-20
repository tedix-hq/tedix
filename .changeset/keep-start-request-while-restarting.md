---
"@tedix/cli": patch
---

A run started from chat is no longer lost when the runner is waiting to restart onto a newer CLI. The start request stays in place for the runner that replaces it, the runner log says what happened to every request and why, and a failed read of the task is retried before the request falls back to the next pass.
