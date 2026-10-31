---
"@tedix/cli": patch
---

Check accepted Work before historical delivery retries so old reconciliation failures do not delay fresh pickup. Keep live orphan ownership checks first, preserve uncertain admission fences, and revisit historical receipts fairly while the lane is idle.

Do not reserve worker slots for settled receipts whose old process IDs have been reused by unrelated processes.
