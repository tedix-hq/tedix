---
"@tedix/cli": patch
---

Lane worktree cleanup fails closed when a busy host stalls its lsof/ps sweep instead of leaking an unhandled rejection that can stop the dispatcher, and historical commit proof reads each commit's date and trailers in one git call to cut subprocess cost.
