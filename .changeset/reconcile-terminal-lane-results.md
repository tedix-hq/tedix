---
"@tedix/cli": patch
---

Close Work after recovering a successful settlement whose reply was lost, checking its current revision and latest Attempt before recovered closure or retries. Allow known terminal failed Work to retry when its historical process ID has been reused, while preserving uncertain admission and canonical admission checks.
