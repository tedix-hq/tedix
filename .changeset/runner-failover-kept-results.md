---
"@tedix/cli": patch
---

Fall-over skips a task whose last run on this revision kept a result for its runner (a question to a person, a deferral, a landed commit awaiting proof). A task refused as not startable (missing approval, purpose or budget) is tried again after an hour instead of every 5 minutes.
