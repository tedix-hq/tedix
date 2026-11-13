---
"@tedix/cli": patch
---

Lane dispatchers no longer re-read a waiting task on every pass. A task that waits for its owner, and an earlier run that is still alive, are now read again after five minutes or when the run's lease ends, which leaves more of the login's request budget for chats.
