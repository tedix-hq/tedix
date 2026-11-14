---
"@tedix/cli": patch
---

`tedix supervise` now sends runner health reports one at a time, retries a timed-out report with a longer limit, and logs how long a failed report took. Reports no longer time out together when several runners are active, so runner health in Tedix OS stays fresh.
