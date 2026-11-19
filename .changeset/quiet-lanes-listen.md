---
"@tedix/cli": patch
---

Keep active Codex and Claude runs alive when the dispatcher cannot confirm an elapsed local lease and has received an agent event in the last minute. Stop the child if the server confirms the Attempt is no longer live or the stream goes idle while the lease remains unconfirmed.
