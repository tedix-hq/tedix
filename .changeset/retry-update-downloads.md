---
"@tedix/cli": patch
---

`tedix update` and `install.sh` now retry release metadata reads and binary downloads up to 3 times on connection, DNS, timeout and 5xx failures, and on final failure name the failing URL, the error class and a next step instead of "Unable to connect".
