---
"@tedix/cli": patch
---

A runner over its checkout cap now actually frees the disk. Until now it
logged "evicting oldest first" on every sweep and removed almost nothing: a
checkout with a leftover scratch file, or with a commit that reached main
under another SHA after a rebase, counted as the only copy of someone's work
and was kept forever. Two runners had grown to 200 GB and 370 GB against a
10 GB cap.

Under cap pressure, a finished checkout untouched for three days is now
removed after its commits and a snapshot of its uncommitted files are saved
in the runner's source repository under `refs/lane-evicted/<run>/<checkout>`.
Recovery folders left by a failed checkout (`repo.orphan-*`) and folders Git
no longer knows are deleted after three days. A run in progress, one awaiting
proof and any checkout touched in the last three days still stay. When the
cap still cannot be met, the log says how many folders refused removal
instead of claiming eviction.
