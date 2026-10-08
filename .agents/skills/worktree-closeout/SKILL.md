---
name: worktree-closeout
description: Finish work in a git worktree of this repository and remove it safely. Use after your change is pushed or abandoned, before ending a session, or when asked to clean up worktrees.
---

# Close out a worktree

Parallel sessions share one repository and many worktrees. Leave only what
another session still needs.

1. **Confirm the work is landed.** `git status --short` is empty and
   `git merge-base --is-ancestor HEAD origin/main` succeeds after
   `git fetch origin main`. If either fails, push or record the work first; do
   not discard changes to make a worktree removable.
2. **Discard generated state, not work.** Changes to `wrangler.jsonc` or
   `cloudflare.config.ts` that rewrite a whole Worker config are a materialized
   deployment overlay. Restore them with `git restore <path>`; never commit
   them (see the deployment boundary in `AGENTS.md`).
3. **Leave the worktree.** `cd` to the main checkout so no shell of yours is
   inside it.
4. **Remove only your own.** `git worktree remove <path>` (no `--force`), then
   `git branch -d <branch>` for a merged branch. Delete your scratch files.
5. **Sweep the rest only when asked.** `bun run worktree:gc` reports every
   worktree of this repo; `--apply` removes only the `merged` rows: clean, in
   `origin/main`, unlocked, idle for two hours and with no process inside.
   `dirty`, `unmerged`, `recent`, `in-use` and `locked` rows belong to someone;
   report them instead of removing them.

Never remove the main checkout, a locked worktree, or a worktree with commits
that are not in `origin/main`.
