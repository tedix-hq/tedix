---
"@tedix/cli": patch
---

A runner now deletes its record of an expired run once the Work has a newer revision. Before, such a record stayed forever when the run's result was still waiting to be reported.
