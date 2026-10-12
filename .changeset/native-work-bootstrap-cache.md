---
"@tedix/cli": patch
---

Native `tedix work` verbs reuse the gateway's catalog bootstrap for up to 6 hours instead of fetching it on every command, and read verbs (`get_*`/`list_*`) send their call alongside the catalog checks, using the answer only when the checks resolve the same tool. A warm read now takes one round trip instead of three.
