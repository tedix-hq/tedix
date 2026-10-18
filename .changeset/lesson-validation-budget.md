---
"@tedix/cli": patch
---

Allow six seconds for the live lesson validation read so a busy gateway does not suppress new feedback lessons. Validation still fails closed, and hook tracing includes this read's timing.
