---
"@tedix/cli": patch
---

The SessionStart hook now hands the model this chat's exact host and model details and asks it to open its owner-host Agent-Session on its first Tedix call, instead of opening it from the hook. A slow first gateway call no longer drops the session line, the session uses its own key so `tedix agent start` keeps working in the same chat, and the line survives when the Work preflight stops early.
