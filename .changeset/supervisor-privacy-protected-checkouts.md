---
"@tedix/cli": patch
---

The background supervisor no longer runs its delivery reads inside folders that macOS privacy protection guards, such as Documents, Desktop, Downloads and iCloud Drive. Those reads always timed out there, so answers and drafts were not delivered to sessions in a checkout under `~/Documents`. They now resolve at once from the session's default binding.
