---
"@tedix/cli": patch
---

`tedix lane routing` now says who takes which tasks in plain words, like the desktop app: one line such as "Right now every task goes to Codex." when every rule names the same agents, or one line per kind of task ("Small routine tasks go to OpenCode, then Codex.") only when the rules differ. Rule names, tags, model ids and the budget sentence no longer appear unless a budget file is configured. `--json` output is unchanged.
