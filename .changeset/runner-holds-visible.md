---
"@tedix/cli": patch
---

Background runners (`tedix lane serve`) no longer park a task silently. When a runner stops starting a task until someone changes it (three failed runs, a result already recorded for that version, or a finished run that Tedix refused to complete), it now records the hold on the task with a one-line reason and sends one request to the task's accountable owner. Tedix shows the task under Stuck on the Work page and stops offering it to runners; editing the task makes it ready again. Tasks that were already parked before this release are recorded the same way, a few per pass.
