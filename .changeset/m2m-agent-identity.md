---
"@tedix/cli": minor
---

`tedix agent start` no longer creates an "External agent …" API key. A new agent gets its own M2M identity, limited to the MCP tools it may use, and that identity opens its sessions and runs its Work. Profiles that still carry an API key keep working in this release; the next minor release stops accepting them, so run `tedix agent start` again on each machine and revoke the old key.
