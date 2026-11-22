---
"@tedix/cli": minor
---

Runners wait until the time a tool names in its own limit message ("try again at Nov 23rd, 2026 12:18 AM") instead of retrying it every hour, and also recognise Codex's out-of-credits message. `tedix lane routing` lists each tool's availability ("Codex: out of credits or at its usage limit, back around 00:18"); `--json` adds a `tools` list.
