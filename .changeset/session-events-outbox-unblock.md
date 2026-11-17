---
"@tedix/cli": patch
---

The local session-events outbox no longer stalls or loses events silently. When an upload fails, events are retried one by one; an event the server rejects three times while taking others moves to the outbox's `rejected/` folder instead of blocking newer events. Session start now uploads events an earlier chat left behind. Very long turn text is cut to 500,000 characters, keeping its start and end. `outbox.log` in the outbox folder records every event set aside or trimmed.
