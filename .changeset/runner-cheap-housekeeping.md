---
"@tedix/cli": patch
---

A runner with many retained runs no longer keeps a processor core busy while
idle. Every ten minutes it measured the size of every run folder again, and it
checked every checkout it could not remove again. Now a finished run is
measured once and again only when it changes, the sizes survive a runner
restart, and a checkout whose removal was refused is tried again after 10
minutes, then 20, doubling up to 2 hours.

The same sweep now also removes clean, landed checkouts that an earlier retry
left beside the current one (`repo-2`, `repo-3`, …) and keeps only the newest
100 folders in `archive/`. A checkout with uncommitted or unpushed work, or
one a running or retained Attempt uses, still stays.
