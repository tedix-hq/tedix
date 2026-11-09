---
"@tedix/cli": patch
---

The dispatcher no longer reruns a review or verification lane whose agent finished and reported the outcome incomplete. It holds the Work with a comment so the repair is routed first, keeping the second Attempt for the repaired version. Coding lanes still get one rerun because they resume their retained change.
