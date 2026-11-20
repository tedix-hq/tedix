---
"@tedix/cli": patch
---

A runner over its checkout space limit now frees old checkouts whose only leftovers are ignored files, such as generated local config. It used to keep them forever.
