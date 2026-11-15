---
"@tedix/cli": patch
---

A runner on a busy machine no longer fails a task because the agent's
`--version` check was slow. A check that takes longer than 5 seconds is tried once more
with a 15-second limit. If that also times out, the runner waits and tries
again later: the task is not counted as a failed start and is not held after
three tries. The runner log records the slow check once as
`executor-probe-slow`.
