---
"@tedix/cli": patch
---

Keep ready-work pickup ahead of bounded cleanup of old lane runs. Remove only idle, clean worktrees whose commits are on origin/main, preserve unfinished work, and allow settled failures to retry without changing the Work version.
