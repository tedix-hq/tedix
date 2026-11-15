---
"@tedix/cli": patch
---

The runner now retries a task that waited more than once or that was cancelled because the runner was stopping. Before, a second "deferred" wait or a stop during start left the task held until someone changed it. A task that a person or the agent cancelled is still left alone.
