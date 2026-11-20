---
"@tedix/cli": patch
---

The runner state a tedi reads from a Mac no longer counts runs that are not there. A task that a runner was starting was listed as a live run for as long as its record stayed on disk, even after the runner was stopped or the start had failed. It now counts only while the runner is running and the start is less than 15 minutes old. Each live run also shows who runs it, the model, the step it is in and the minutes so far.
