---
"@tedix/cli": patch
---

A runner now starts waiting tasks sooner on a slow or rate-limited connection. A start request for a task whose earlier start failed before Tedix was asked for an Attempt (for example on a read timeout) starts it again at once instead of leaving it to the next pass. A pass first starts every task it may start and only then reads the tasks that wait for an owner's comment, so those reads no longer hold back tasks further down the list. Reads of the runner rules and the rules skill are tried again like other reads instead of failing the start on one slow answer.
