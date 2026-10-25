---
"@tedix/cli": patch
---

`tedix agent start` now resumes the owner approval its first-time credential bootstrap parked on, instead of opening a new approval request on every retry. While the decision is pending it says so and names the request; `tedix lane serve` defers that Work instead of holding it, so the lane admits as soon as the owner approves.
