---
"@tedix/cli": patch
---

`tedix lane serve` now waits out a gateway rate limit on your login instead of timing out every read, and the local Work catalog cache drops expired entries so it stays small.
