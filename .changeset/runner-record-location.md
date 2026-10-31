---
"@tedix/cli": patch
---

Keep the supervisor's runner records out of the runner's own directory. 0.19.0 wrote them there, and the runner read them as broken Work receipts and held new admissions; 0.19.1 stores them under `~/.tedix/supervisor/runners/` instead.
