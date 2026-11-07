---
"@tedix/cli": patch
---

`tedix supervise` now keeps a Mac awake while it runs, so runner Attempts are not cut off by idle sleep. On power it also stays awake with the lid closed; on battery, closing the lid still puts the Mac to sleep.
