---
"@tedix/cli": patch
---

Retry temporary catalog admission refusals before any tool runs, using the existing bounded retry policy and the server's retry hint.
