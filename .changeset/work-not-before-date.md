---
"@tedix/cli": patch
---

A task can now wait for a date. `tedix work not-before <id> <time|clear>` sets or removes a task's start date (for example `2026-12-01`, UTC); Tedix does not offer the task to a runner before then and `tedix work readiness <id>` reports `not_before` with the date. An agent that finds nothing can be done before a known date ends with `outcome: "deferred"` and `notBefore`; the background runner (`tedix lane serve`) then sets that start date on the task and comments why, so no other runner starts it early. Before, such a task was started again and each run found nothing to do.
