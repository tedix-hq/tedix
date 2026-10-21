---
"@tedix/cli": patch
---

Enable OpenCode decision capture, request-ledger recording, await-reply wake and turn-status reporting through the existing lifecycle hooks and opt-ins. Bind each idle reply listener to its captured turn so a stale question cannot wake a newer turn.
