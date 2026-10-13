---
"@tedix/cli": patch
---

Keep the shared login alive when a host kills a timed-out hook or the Mac drops back to sleep. Login renewal now runs outside the hook's process tree and does not start while a sleeping Mac is briefly awake in the background. Each renewal is recorded in `~/.tedix/renewals.log` without secrets, so a future logout names the process that caused it.
