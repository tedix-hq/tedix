---
"@tedix/cli": patch
---

`tedix work start` refused for a missing executor identity now says which piece is missing (no Agent-Session, no identity on the workspace, a session not started, or a started session the call did not use) and prints the one command that fixes it.
