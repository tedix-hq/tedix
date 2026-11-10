---
"@tedix/cli": patch
---

A Work item no longer stops after three Attempts that ended before the agent turn started — for example when the dispatcher crashed or the checkout was missing. Those Attempts are now recorded as dispatcher faults instead of agent failures, and the item is retried rather than held for a person.
