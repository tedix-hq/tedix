---
"@tedix/cli": patch
---

Let the lane dispatcher drain workers on shutdown without the embedded runner forwarding termination signals to them. Direct lane runs still forward signals.
