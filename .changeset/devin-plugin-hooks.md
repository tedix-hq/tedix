---
"@tedix/cli": patch
---

Let Devin plugin hooks defer to the existing Tedix-managed setup and lane hooks,
so installing the plugin alongside the fallback setup does not record turns twice.
