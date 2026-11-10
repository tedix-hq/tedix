---
"@tedix/cli": patch
---

The dispatcher now says why it left a timed-out agent run running when it cannot prove the process belongs to that run, instead of skipping it silently. After starting an agent, it also keeps trying for a few seconds to record the process's identity, so a run started on a busy machine can still be stopped later if it gets stuck.
