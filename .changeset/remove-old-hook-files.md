---
"@tedix/cli": patch
---

Small files the hooks write for each session and answer (in `hook-cache`, `session-scopes` and `feedback-outbox`) are now deleted once they are 30 days old. Before, nothing removed them and they grew to tens of thousands of files.
