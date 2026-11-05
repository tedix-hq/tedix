---
"@tedix/cli": patch
---

`tedix supervise` now restarts a lane runner that stops making passes: about four minutes after a missed pass it kills the runner and starts a fresh one, and writes the reason to `~/.tedix/supervisor.log`. A stopping runner waits at most two minutes for running work before it exits, so the replacement no longer waits behind a whole model turn; the new runner recovers work left running.
