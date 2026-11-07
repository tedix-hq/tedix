---
"@tedix/cli": patch
---

A lane that finished its run and delivered its result no longer fails just because the final agent message lacked the bounded result declaration. During settlement the dispatcher now recovers the outcome from Attempt evidence — a commit landed under the Attempt's custody on origin/main, or a result comment the admitted session posted on the Work — and writes the declared outcome under the admitted fence itself. A run with no such evidence still fails, and coding Work still needs landed commit, skill revision, or installed runtime app proof.
