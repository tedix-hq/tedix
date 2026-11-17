---
"@tedix/cli": patch
---

With decision capture enabled, a typed message or agent turn is saved to the local session-events outbox before the sign-in check, so a slow or failed check no longer loses it; the next hook uploads it.
