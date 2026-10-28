---
"@tedix/cli": patch
---

Install dependencies before starting a Devin dispatcher child. Missing-module
crashes while loading pre-push checks no longer consume the push retry budget.
