---
"@tedix/cli": minor
---

Add `tedix work run <id> -- <command>` to start an Attempt, keep its lease alive while the command runs, and settle by its exit code. Renewal refusal stops the command; Ctrl-C releases the Attempt without failing it. Use `--note` for result text and `--commit` for coding results.
