---
"@tedix/cli": patch
---

Landed Work that names another repository under the same GitHub owner, or runs from an ops checkout, is now verified against that repository's main and its latest successful Ship run instead of waiting for the product health revision to contain commits it will never hold.
