---
"@tedix/cli": patch
---

Runners send run steps less often so several runs at once stay under the server's call limit. A run with nothing new asks for messages every 15 seconds instead of every 5, runs share one budget, and a run that is told to slow down waits longer before it tries again.
