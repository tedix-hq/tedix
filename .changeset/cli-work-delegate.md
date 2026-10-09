---
"@tedix/cli": patch
---

`tedix work delegate "<title>" --done-when "…" --via subagent|session` registers a lead session's hand-off as an accepted Work Item (reusing an open one with the same title) and comments the brief; `--done <id> --note "…"` records the outcome and completes it. The prompt-context hook lists that session's open delegations, at most eight, as the lowest-priority context.
