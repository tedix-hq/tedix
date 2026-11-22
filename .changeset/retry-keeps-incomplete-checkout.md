---
"@tedix/cli": patch
---

A runner's retry after a run that ended incomplete (for example, its push was refused) now continues in that run's checkout, with its unpushed commits, and resumes the same agent session. Before, such Attempts settle as `rejected`, the retry did not recognise them, and it started in a fresh checkout and session without the earlier commits.
