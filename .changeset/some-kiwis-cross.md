---
"@tedix/cli": patch
---

Lane runners re-check an admission left unknown by a transient error once its retry time passes, adopting the session's Attempt or re-admitting the Work instead of skipping it forever.
