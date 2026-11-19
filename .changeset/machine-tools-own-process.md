---
"@tedix/cli": patch
---

A tedi's machine tool calls are answered by a process of their own (`tedix lane serve --machine-tools-only`), which the supervisor starts and keeps running, one per machine. Before, the Codex runner answered them, and calls waited for minutes while it was busy with agent runs. The log (`~/.tedix/dev.tedix.machine-tools.log`) repeats a failing claim every minute and says when claims work again.
