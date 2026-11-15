---
"@tedix/cli": patch
---

Creating a task's checkout no longer stalls the runner or fails after 30 seconds on a large repository. The runner keeps working while Git creates the checkout and allows it up to five minutes. If it still fails, the half-made checkout is removed before the next try and the error shows Git's own message or how long it waited.
