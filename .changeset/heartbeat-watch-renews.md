---
"@tedix/cli": patch
---

`tedix work heartbeat --watch` now keeps renewing through a timeout, dropped connection or 5xx error while the confirmed lease lasts, and prints why it stopped, including when it reaches its horizon (the number is the total run time, not the interval).
