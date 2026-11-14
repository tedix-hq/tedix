---
"@tedix/cli": patch
---

Runners move to a new CLI version by themselves after `tedix update`. A runner
the supervisor keeps running notices the newer installed version, takes no new
Work, lets the Work it already has finish, and then restarts; no running
Attempt is cancelled. The supervisor log says `runner <executor> now on
<version>` for each runner.
