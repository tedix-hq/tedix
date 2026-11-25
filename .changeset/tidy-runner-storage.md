---
"@tedix/cli": patch
---

The command-line tool now cleans up after itself: `tedix supervise` compacts regenerable folders (node_modules, dist, build, …) out of settled run worktrees an hour after they go quiet, expires run folders three days after settling or seven days idle while keeping unpushed commits as restore points for 90 days, and rotates per-lane, runner and supervisor logs at 10 MB keeping 10 files. The new `tedix storage` command shows real disk use by area — APFS clones counted once — and `tedix storage clean` runs the same pass now. Every threshold lives in `~/.tedix/retention.json`.
