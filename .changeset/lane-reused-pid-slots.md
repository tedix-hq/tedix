---
"@tedix/cli": patch
---

`tedix lane serve` no longer counts an ended run against its capacity when that run's process ID now belongs to an unrelated process. Before, such leftover runs could fill every slot and stop new Work from starting.
