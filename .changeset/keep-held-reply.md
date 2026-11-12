---
"@tedix/cli": patch
---

A chat reply that could not be sent to Tedix is now kept until it is delivered or its question expires. Before, it was dropped after one failed retry, for example while the gateway was rate-limiting the login.
