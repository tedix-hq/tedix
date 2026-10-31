---
"@tedix/cli": patch
---

Keep an interrupted task's checkout and native-session references when a preparation read fails before fresh admission. Preserve its checkpoint across retries without reviving the expired lease or treating its old process as running.
