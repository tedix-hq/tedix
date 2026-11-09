---
"@tedix/cli": patch
---

When the supervisor restarts the dispatchers, a dispatcher that was still preparing a job no longer starts the agent anyway. It hands the job back, without spending one of the job's tries, so the new dispatcher picks it up. Before, the old dispatcher could start a run after it was told to stop, then leave that run behind when it exited.
