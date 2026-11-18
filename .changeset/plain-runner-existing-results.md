---
"@tedix/cli": patch
---

Reject already_satisfied results without CI recovery approval with guidance to use
landed_unverified and existingCommits for non-CI tasks already satisfied on main.
Make that distinction explicit in runner briefs instead of leaving results pending.
