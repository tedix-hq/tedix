---
"@tedix/cli": patch
---

Stop expired executor lanes once, persist their interruption, and force termination
after a five-second grace period when a child ignores SIGTERM.
