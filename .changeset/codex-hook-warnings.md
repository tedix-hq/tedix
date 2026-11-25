---
"@tedix/cli": patch
---

`tedix setup agents --status` no longer reports Codex hook trust as unknown when Codex only warns about a hook, and the Codex plugin bundled with the Mac app ships its session-end hook within Codex's limits.
