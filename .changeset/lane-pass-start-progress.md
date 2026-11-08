---
"@tedix/cli": patch
---

`tedix lane serve` marks pass progress when a pass and each gateway call start, not only when a call ends, so a slow first call no longer makes the supervisor kill the runner during its own startup.
