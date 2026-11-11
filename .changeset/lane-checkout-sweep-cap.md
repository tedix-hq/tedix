---
"@tedix/cli": patch
---

Reclaim lane runner checkouts once a run settles: the dispatcher now removes a `runs/` checkout as soon as every commit is on `origin/main` or recorded on the Work, sweeps all settled and orphaned runs on start and every ten minutes, and keeps retained checkouts under a cap (10 GB per runner by default, `--checkout-cap-gb` or `TEDIX_LANE_CHECKOUT_CAP_GB` to change). A checkout with a live Attempt or unrecorded unpushed commits is never removed, and each removed run keeps its receipt JSON.
