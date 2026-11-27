---
"@tedix/cli": patch
---

`tedix poppy call --surface mcp` now reaches MCP servers that require clients to accept both JSON and streamed replies, instead of failing with HTTP 406.
