---
"@tedix/cli": patch
---

On Linux, a dispatcher that restarts can now reliably stop an agent run left behind by the previous dispatcher. Before, if the run's identity was recorded at the exact moment the agent was starting, it could be read in a different format than later checks used, so the dispatcher never recognized the run as its own and left it running.
