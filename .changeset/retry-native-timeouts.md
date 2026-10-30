---
"@tedix/cli": patch
---

Keep native preparation timeouts on bounded backoff instead of permanently holding Work after three failures. Recover existing timeout holds before session creation while preserving admission denials and uncertain Attempts.
