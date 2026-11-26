---
"@tedix/cli": patch
---

Renew Work Attempt leases on one shared schedule — a third of the remaining lease — across the runner, `work heartbeat --watch` and lane watches, and report a missed renewal once. Lane session states now come from the Attempt's own state instead of a separate lane liveness report.
