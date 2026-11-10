---
"@tedix/cli": patch
---

A lane runner's log no longer grows without bound. The dispatcher writes a skip or wait line only when an item's reason changes (repeating an unchanged reason once an hour), rotates its `dispatcher.log` past 4 MB, and the supervisor cuts each runner's log back to its newest lines once it passes 8 MB, marking where older lines were dropped.
