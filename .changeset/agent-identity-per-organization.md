---
"@tedix/cli": patch
---

Runners can serve more than one organization from one login. Each organization now gets its own agent identity, chosen by `--organization` (or `TEDIX_ORGANIZATION`), instead of every runner reusing the first organization's identity.
