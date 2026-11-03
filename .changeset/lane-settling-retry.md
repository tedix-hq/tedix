---
"@tedix/cli": patch
---

`tedix lane serve` now retries a retained settlement when its Work Item comes up for dispatch, even while other Work is still preparing. A failed Attempt read backs off instead of stopping the whole pass, and once the Attempt is confirmed expired the same Work revision is admitted again without a new Work version.
