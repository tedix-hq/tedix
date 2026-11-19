---
"@tedix/cli": patch
---

`tedix lane serve` checks Codex network health and Claude Code plugin and MCP startup before claiming Work. An unhealthy executor pauses pickup and logs the first failure, then retries with backoff.
