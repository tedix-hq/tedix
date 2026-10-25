---
"@tedix/cli": patch
---

`tedix work heartbeat --watch` now recovers when the server revokes an agent
credential before it expires: it fetches a fresh credential once and keeps
renewing the same Attempt, and stops if the new credential is rejected too.
