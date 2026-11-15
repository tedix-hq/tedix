---
"@tedix/cli": patch
---

The session and prompt hook no longer waits out a gateway rate limit before
its organization check. While the gateway is rate-limited it skips the check
and says "gateway is rate-limited until <time>; organization check skipped"
instead of timing out with "organization could not be verified", which
wrongly pointed at the login or organization.
