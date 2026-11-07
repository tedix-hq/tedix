---
"@tedix/cli": patch
---

Retry lane claim reads, fenced heartbeats and undelivered-answer reads with jittered backoff inside one logged, load-aware deadline. Admission writes retain their existing unknown-response reconciliation rather than being resent.
