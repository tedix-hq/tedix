---
"@tedix/cli": patch
---

Use the blocking Work wait for parked human requests instead of repeatedly reading their answers. Persist the cursor across runner restarts and keep other Work moving while a wait is pending.

Replace the separate answer and draft polling hooks with `await-input`. Session supervisors use the same blocking wait and read answers only after it wakes. Update the CLI and local plugin together after the API is deployed.
