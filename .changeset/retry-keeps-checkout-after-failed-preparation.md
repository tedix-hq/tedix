---
"@tedix/cli": patch
---

A retry that fails before it starts (for example, a database read fails while it prepares) no longer loses the earlier run's checkout: the next try still continues in that checkout, with its unpushed commits, and resumes the same agent session.
