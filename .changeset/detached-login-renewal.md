---
"@tedix/cli": patch
---

Renew a stored login in a detached process, so a command killed during renewal (for example by a hook deadline) no longer loses the rotated refresh token and logs out every session on the machine. The renewal deadline now also covers the response body.
