---
"@tedix/cli": patch
---

`tedix agent start` now says why a sign-in was rejected. A session key already registered with other harness or model flags names the conflict and how to reuse or replace the key; rate limits and a missing principal get their own messages, and an unclassified rejection carries the gateway's reason instead of a bare status.
