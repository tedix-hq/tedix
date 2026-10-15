---
"@tedix/cli": minor
---

Add `tedix mcp call <method> [--params <json>] [--header <name=value>]` to send one raw MCP JSON-RPC request, such as `events/list` or `events/poll`, to the selected workspace's gateway with the stored login. The token stays inside the CLI and is never printed.
