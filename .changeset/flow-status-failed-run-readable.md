---
"@tedix/cli": patch
---

`tedix skill status` and `tedix flow status` read a failed run as a failed run, not as "polling the run failed", and print the failing tool and its error on one line instead of nested JSON.
