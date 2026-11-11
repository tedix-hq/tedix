---
"@tedix/cli": patch
---

Say why `lane serve` counts an executor as unavailable instead of logging the same "No eligible local executor" line for every cause: the skip reason now names each rejected route — the `--version` probe's exit status, signal or timeout with elapsed ms, or the budget backoff or near-limit that paused it. A passing probe is also reused for five minutes per executor, so one slow spawn on a busy machine no longer drops a healthy lane.
