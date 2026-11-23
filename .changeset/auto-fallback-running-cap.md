---
"@tedix/cli": patch
---

Coordinated Auto assignment now respects each harness's `maxRunning` cap on the fallback path too: a preferred tool already at its cap is skipped for the sole eligible alternate, and when every tool is full the task stays unassigned until capacity returns instead of being assigned over the cap.
