---
"@tedix/cli": patch
---

Retry native tool calls refused because Attempt authorization is temporarily unavailable. The typed refusal states that nothing executed; the CLI waits with jitter and retries at most twice within the call's deadline. Untyped failures and errors that may have executed are not retried.
