---
"@tedix/cli": patch
---

`tedix update` no longer signs the command-line tool with a local certificate, and `tedix supervise install` no longer points to Full Disk Access. macOS keeps background programs out of Documents, Desktop and Downloads; keep checkouts somewhere else, for example `~/Developer`. When the supervisor cannot read a session's folder it says so and names that rule.
