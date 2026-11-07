---
"@tedix/cli": patch
---

The supervisor no longer restarts a runner whose pass is slow but still making progress. Previously a long pass over many items was killed mid-dispatch and started again from the top, so items further down the list were never started.
