---
"@tedix/cli": patch
---

`tedix supervise install` now reinstalls over a loaded LaunchAgent: it waits for the old job to unload, retries the bootstrap, and confirms the job with `launchctl print` before reporting success.
