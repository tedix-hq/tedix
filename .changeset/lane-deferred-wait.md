---
"@tedix/cli": patch
---

A lane agent that reports its Work is waiting on a date, an approval, a person or production access can now declare `outcome=deferred` with the reason and an optional recheck time. The dispatcher settles that Attempt as cancelled instead of failed and revisits the item after the wait, so held Work no longer piles up on the three-failure hold although nothing went wrong.
