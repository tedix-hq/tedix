---
"@tedix/cli": patch
---

The dispatcher now locks each lane checkout until it has collected proof and removes it itself, so an agent that cleans up its worktree can no longer make a finished Attempt fail.
