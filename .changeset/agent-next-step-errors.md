---
"@tedix/cli": patch
---

Errors and output that tell a coding agent its next step. `tedix code` now prints every inner tool call that failed and exits 1, even when the program's own result hides the failure. `work start` without an executor identity names `tedix agent start` and the `TEDIX_EXTERNAL_AGENT` prefix; `work accept` and `work complete` refused for the external agent say to rerun with the owner login; `work checkpoint` without selected Work says how to find and select it. `factory status <slug>` shows each run's ID and a failed run's error, with the command that reads it. `workflow list|health|runs` fetch only the fields they print, so a normal page no longer overflows the gateway. A local command given gateway options prints the command to run instead.
