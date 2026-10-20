---
"@tedix/cli": patch
---

Permit read-only environment examples in sandboxed Devin checks while keeping real environment variants and all environment-file writes denied. Keep temporary files and package caches inside the lane worktree so guarded push checks can install dependencies.
