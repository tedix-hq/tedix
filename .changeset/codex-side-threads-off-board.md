---
"@tedix/cli": patch
---

The status and decision-capture hooks now ignore Codex side threads that Codex never saves, such as prompt suggestions and memory consolidation. These threads no longer appear on the Agents board as separate sessions or post raw JSON summaries.
