---
"@tedix/cli": patch
---

Retry known local quota reserves and active backoffs on the existing bounded schedule instead of permanently holding Work after three capacity pauses. Keep executor assignments, reserve thresholds, retry caps, and holds for other failures unchanged.
