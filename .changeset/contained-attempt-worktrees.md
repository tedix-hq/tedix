---
"@tedix/cli": patch
---

Default attempt worktrees to the primary repository's ignored `.worktrees/`
directory. After successful `work settle`, `complete`, or `cancel`, remove
the current session's matching clean worktrees and their correlation files
when their commits are confirmed on remote `main`. Retain dirty, locked,
unpublished, or mismatched worktrees and report cleanup failures separately.
