---
"@tedix/cli": patch
---

`tedix supervise` no longer changes its own working directory to resolve a session's context (a `getcwd` EINTR under launchd failed every check); reads run in the session's checkout instead. A failed CLI read now names the exit code or signal and the tail of the child's stderr, and the supervisor log says why undelivered answers could not be read.
