---
"@tedix/cli": patch
---

`tedix lane serve` now frees `runs/` space under cap pressure for checkouts idle for an hour (it was three days), after saving their commits and uncommitted files as a Git ref. When the cap still cannot be met, the log names each folder it kept and why (`checkout-held`).
