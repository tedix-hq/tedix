---
"@tedix/cli": patch
---

Keep `tedix work heartbeat <id> --watch` renewing the Attempt through a dropped connection or timeout: a single ECONNRESET, ETIMEDOUT or other transient network failure now retries with backoff inside the confirmed lease instead of ending the watch, which previously let the Attempt go stale.
