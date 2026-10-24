---
"@tedix/cli": patch
---

`tedix lane serve` retries Work whose earlier dispatch failed before admission instead of skipping it forever over the leftover checkout; a dirty leftover stays for inspection.
