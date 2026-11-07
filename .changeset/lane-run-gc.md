---
"@tedix/cli": patch
---

`tedix lane serve` reclaims run directories that no receipt refers to (one per pass), treats a checkout whose only changes are deletions as removable, and holds new admissions with a `disk-low` event when free disk under the dispatcher directory drops below 10 GB.
