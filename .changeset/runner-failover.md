---
"@tedix/cli": minor
---

Work waiting for a tool that has been unavailable for 5 minutes (out of credits, at its usage limit, or failing its start check) moves to the next available tool in its routing rule, with the reason written on the task. Running tasks stay. `metadata.onlyExecutor: true` keeps a task on its tool.
