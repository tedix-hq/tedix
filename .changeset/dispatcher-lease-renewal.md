---
"@tedix/cli": patch
---

Local dispatchers reuse an in-process connection to renew Work leases. A shared gateway cooldown or a queued dispatcher read no longer delays those heartbeats.
