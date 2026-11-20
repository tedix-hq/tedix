---
"@tedix/cli": patch
---

A Claude Code runner takes Work again when one of your Claude plugins is offline or waits for sign-in; only a broken plugin or MCP configuration still pauses it. When a runner is over its checkout space limit, it now also frees checkouts that a held task no longer uses, and stops dev servers an ended run left running in its folder, saving any unpushed work first.
