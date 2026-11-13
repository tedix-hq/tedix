---
"@tedix/cli": patch
---

Lane dispatchers clear stale held records instead of retrying them forever. A retained receipt or retry deadline no longer blocks admission once every open Attempt's lease has expired. An orphan whose Attempt ended under another session or is absent from the complete ledger is released for fresh admission. Settlement retries stop once the Work is completed or cancelled, or when the Attempt fence is gone or contradicts the local claim. A retained run folder or agent session that no longer exists is skipped with one clear log line and reprovisioned instead of failing every pass.
