---
"@tedix/cli": patch
---

A runner no longer resumes a task in a retained checkout that shares no history with main; the task gets a fresh checkout and the old folder is left in place.
