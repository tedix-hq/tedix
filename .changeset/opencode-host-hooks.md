---
"@tedix/cli": minor
---

Support OpenCode sessions: `tedix hooks session-start|prompt-context|situational-recall --host opencode` accept OpenCode's native `ses_` session id for the new OpenCode plugin, and `TEDIX_AGENT_SESSION=opencode:<id>` resolves to the `opencode` harness for `tedix agent start`.
