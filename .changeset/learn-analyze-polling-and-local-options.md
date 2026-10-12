---
"@tedix/cli": patch
---

`tedix learn analyze-sessions` no longer reports polling loops (`until … sleep`, `gh run watch`, `--watch`) as long stalls, and names a command that starts with a variable assignment by the command it runs instead of "shell". `tedix -w <workspace> learn …` now says to put options after `learn` instead of failing with "Unknown option".
