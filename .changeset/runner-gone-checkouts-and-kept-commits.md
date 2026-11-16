---
"@tedix/cli": patch
---

Background runners (`tedix lane serve`) free disk they could not free before, and keep track of finished commits that did not reach main.

- A run folder whose checkout was already removed is archived. Before, the runner asked Git to read the missing checkout on every pass and logged `git cannot read the checkout` for it forever. The registration a removed checkout left behind is released, so the next run gets the same path instead of a `repo-2` copy.
- When the runner is over its disk cap, it now also removes checkouts that an earlier try of the same task left behind, and checkouts the ordinary cleanup had refused. Their commits and uncommitted files are saved first under `refs/lane-evicted/<run>/<checkout>`. A leftover folder that Git no longer knows is saved the same way before it is deleted.
- The reason `git cannot read the checkout` now includes what Git reported.
- When a run commits a change but cannot push it, the runner keeps the checkout and its commit list on record through later holds and failed starts. The hold on the task names those commits and where they are. The next run of the task is handed that checkout, or the Git ref that saved it. Before, a held task forgot the checkout, and the next run started from a clean copy of main.
