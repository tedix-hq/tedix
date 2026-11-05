---
"@tedix/cli": patch
---

Add explicit `lane remote-job send|receive` passes for controlled Instinct email jobs, using the held Attempt, authenticated mailbox reads and durable Work evidence. Retain uncertain sends without automatic replay.
