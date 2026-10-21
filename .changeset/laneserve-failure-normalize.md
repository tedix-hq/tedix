---
"@tedix/cli": patch
---

Normalize volatile admission failure diagnostics so repeated failures hold after three attempts. Retry commit-proof fetches with backoff and retain the live Attempt for later verification when origin is unavailable.
