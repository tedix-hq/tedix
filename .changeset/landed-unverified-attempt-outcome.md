---
"@tedix/cli": patch
---

A runner now settles an Attempt as landed_unverified when the lane reports that its outcome was not confirmed, instead of recording it as succeeded. Before, a lane that said the done-when was not met could still leave the Attempt looking like a pass.
