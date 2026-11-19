---
"@tedix/cli": minor
---

A runner can now answer read-only questions about its machine for a tedi: read a file, search the code, list and read commits, read CI runs and the failure lines of a CI job, and report the state of the runners on the machine. Files and history are read from the runner's own copy of main, never from your working folders, and every answer is masked for secret shapes and cut to 20,000 characters. The runner reports a machine name with its health report: the host name, or `machineName` from the saved runner settings. One runner per machine answers: the Codex runner if you have one, otherwise the first in the list.
