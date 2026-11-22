---
"@tedix/cli": patch
---

A stopping runner waits at most 10 seconds for its tasks (was 2 minutes), and the supervisor restarts an exited runner after 5 seconds (was 60), doubling for repeated exits up to 15 minutes. Running tasks continue under the next runner, so a stop no longer leaves them waiting for minutes.
