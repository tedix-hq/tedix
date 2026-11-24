---
"@tedix/cli": patch
---

Let the Claude Code connection check pass when the Tedix connector from claude.ai takes the place of the plugin connection. Claude Code loads one Tedix connection per address, so the check now accepts a profile read through either one.
