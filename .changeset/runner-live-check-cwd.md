---
"@tedix/cli": patch
---

Runners retain a checkout as soon as the kernel reports a process working inside it, without waiting for a full lsof scan. Missing kernel facts still use the existing process probes before removal.

Runner shutdown also waits for pending process identity reads before releasing its state, preventing delayed identity callbacks from writing after cleanup.
