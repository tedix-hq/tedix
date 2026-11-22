---
"@tedix/cli": patch
---

Runners read each tool's own reset time (Claude Code "resets 9pm" or "limit reached|<time>", Codex "try again at …", or an ISO "resets at" time) and also recognise overload, insufficient-quota and low-credit messages. A tool counts as back by itself at that time. When every tool in a task's rule is unavailable, the task waits with one plain comment naming the first tool due back.
