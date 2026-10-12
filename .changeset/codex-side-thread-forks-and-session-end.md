---
"@tedix/cli": patch
---

The status hook now recognizes Codex side threads that carry their parent chat's transcript, such as prompt suggestions, and keeps them off the Agents board. A Codex session's end is now filed under Codex rather than Claude Code, so its board row closes instead of leaving a stray Claude Code entry.
