---
"@tedix/cli": patch
---

A runner over its checkout limit now removes the checkout of a run whose Attempt expired, even while that run's result is still waiting to be reported. The work is saved as a Git ref first and a later run of the same Work restores it. Before, such checkouts stayed for weeks and the limit could not be met. The earlier step that deleted dependency folders from kept checkouts is removed.
