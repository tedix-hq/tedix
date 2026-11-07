---
"@tedix/cli": patch
---

`tedix lane serve` now settles a lane succeeded when the Work's fix is already on `origin/main` and was landed by any admitted Attempt on that Work, such as an interactive session or an earlier dispatch, instead of failing with "No landed commit SHA". A refused commit is logged as `custody-rejected` with the reason.
