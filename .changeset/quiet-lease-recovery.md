---
"@tedix/cli": patch
---

Confirm the server's Attempt lease before stopping an agent at a cached deadline, so a lost renewal reply does not interrupt a live run. Stop promptly when the server refuses a stale Attempt.
