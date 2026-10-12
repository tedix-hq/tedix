---
"@tedix/cli": patch
---

Commands reuse the gateway's protocol discovery for six hours, so `tedix ask` and other commands skip one round trip before their real call.
