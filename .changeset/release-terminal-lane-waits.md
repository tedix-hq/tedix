---
"@tedix/cli": patch
---

A retained `waiting_on_user` receipt no longer blocks dispatch forever when its question was cancelled or expired, or when it belongs to an older Work revision. The dispatcher releases the wait so the lane re-checks the item and raises a fresh question when it still needs a person, instead of logging "no verified resolving human response" on every pass.
