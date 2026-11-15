---
"@tedix/cli": patch
---

Devin runners now wait their turn before running pre-push checks. A Devin
runner could not open the repository's shared check lock, so its checks ran
at the same time as every other session's and slowed the whole machine. The
runner can now take that lock, and its checks queue behind the ones already
running.
