---
"@tedix/cli": patch
---

`tedix lane serve` now asks for a missing delegation in Tedix OS. When a lane skips Work because it may include an action only a person can authorize, it opens one request for the Work's accountable owner with the exact Delegation comment to add. If the Work has no accountable person, it asks the signed-in lane operator to choose one. Later passes reuse the same open request, and the lane never adds the delegation itself.
