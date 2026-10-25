---
"@tedix/cli": patch
---

The session-start hook opens the chat's owner-host Agent-Session when you are signed in and the host reports its harness version and model, and tells the agent to pass that id as `agentSessionId` on every Tedix `code` call, so audit names the agent. A model change mid-chat or any failure adds nothing.
