---
"@tedix/cli": patch
---

Keep `tedix flow run --param` values such as `Infinity` or `1e999` as strings
instead of sending them to the workflow as `null`.
