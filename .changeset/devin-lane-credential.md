---
"@tedix/cli": patch
---

Devin lanes can now use the Tedix CLI from inside their sandbox. The dispatcher gives each admitted Devin lane its own short-lived session credential and renews it every minute. The sandbox still blocks the host credential files. When a blocked read happens, the CLI now says "access denied" instead of calling `external-agents.json` corrupt.
