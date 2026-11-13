---
"@tedix/cli": patch
---

Lane dispatchers make fewer repeat reads for tasks that cannot start. A task whose owner already allowed it is no longer re-read on every pass while something else keeps it waiting, and a task that keeps failing to start the same way is tried once per 30-minute window instead of three or four times.
