---
"@tedix/cli": patch
---

A restarted runner no longer marks a finished run as failed. Since the change that releases runs whose process died, a run that had already ended and was waiting for its commit proof, its completion or a retried settlement was settled as "Recorded agent process is dead" and lost the commit it had landed. Those runs are left to their own settlement again.
