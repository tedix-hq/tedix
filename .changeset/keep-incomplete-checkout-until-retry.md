---
"@tedix/cli": patch
---

The checkout of a run that ended incomplete (for example, its push was refused) is now kept until the Work's retry uses it, instead of being cleaned up about 30 seconds after the run ends. Only the disk cap can still evict it, and then its commits are saved under a Git ref as before.
