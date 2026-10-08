---
"@tedix/cli": patch
---

`tedix agent rename` renames a profile's external-agent principal to the machine and user (or `--display-name`). A profile first set up by one agent no longer makes every later Claude Code or Codex session on it look like that agent; the principal's key stays the same so commit provenance is unaffected.
