---
"@tedix/cli": patch
---

Moving a task to another tool (fall-over or idle takeover) now works: the runner sent the target as `executorReference`, which the server's reassignment refuses.
