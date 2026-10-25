---
"@tedix/cli": patch
---

Reject a blank or non-digit `tedix factory --max-proposals` value instead of treating it as zero; explicit `0` through `10` still work.
