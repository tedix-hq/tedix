---
"@tedix/cli": patch
---

The background supervisor no longer attempts a headless Codex or Claude Code resume in a macOS privacy-protected folder such as Documents, where it always failed with "Interrupted system call". It logs the Full Disk Access grant, or the checkout move, that makes the resume possible.
