---
"@tedix/cli": patch
---

Let the server be the only judge of a stale Attempt. The local attempt cache under ~/.tedix/work-attempts is now only a pointer that remembers the Attempt id; heartbeats, run renewal and settlement no longer refuse when it disagrees, and the server's stale-Attempt error is the only one.
