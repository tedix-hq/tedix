---
"@tedix/cli": patch
---

Keep a refresh token fenced after an HTTP error or malformed token response: the issuer may already have rotated it. Only proven pre-connect failures can retry the same token. This prevents token-family invalidation; automatic recovery of a lost successor still requires issuer support.
