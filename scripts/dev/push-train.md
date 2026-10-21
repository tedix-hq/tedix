# Local push trains

`bun run push` keeps the machine-wide queue. One waiting ticket still fetches,
rebases and pushes through the normal pre-push hook. With multiple clean,
compatible tickets, the oldest process builds one candidate in a temporary
integration worktree under the repository's `.worktrees/`. Recovery
journals stay in the common Git directory. Commits are cherry-picked in arrival
order, retaining their messages, authors and provenance trailers.

Each intermediate commit gets the existing secret scan, including private
rules for the canonical remote. The final normal Git push runs the full hook
once. Its preflight combines the actual pushed range with every original lane
range, so a later lane reverting a file cannot hide an earlier lane's selected
checks. Formatter selection conservatively uses a full check for multiple trees.

A train takes at most 12 lanes (`MAX_TRAIN_LANES`). A lane whose commits
conflict or fail the per-commit secret scan is left out of the candidate; the
others are gated together, and the left-out lane is retried alone on the new
main afterwards, failing without a gate if it still conflicts. A failed gate
splits the candidate into arrival-ordered halves, each rebuilt from fresh main
and gated again; batches of three or fewer go lane by lane. One red lane among
n therefore costs about 1 + 2·log2(n) gate runs instead of 1 + n. Each lane
receives its own result and published SHA; failed lanes do not stop later
independent ones. An external main update rebuilds and re-gates the candidate,
with the same two retries as the single-lane queue.

Tickets pin clean checkouts. Dirty checkouts, merge histories, old queue tickets
and differing dry-run modes are skipped when a train forms and keep their place
for the single-lane path. No holder edits another lane's checkout. A successful lane updates its own branch
only if its original branch, HEAD and clean state still match its ticket.

A process dying before selection is dropped as before. After selection its
pinned commits remain authorized for publication even if the waiting process
dies; the result stays under `<git-common-dir>/push-results/`. If the holder dies
after publication, a later holder verifies the prepared candidate is on main
and restores the exact per-lane SHA receipts from its journal. Living train
locks do not expire during fallback; dead holders remain recoverable.
The temporary integration worktree is removed on normal success or failure.

## Six-lane simulation

Run `bun test scripts/dev/push-queue.test.ts scripts/dev/push-train.test.ts`.
The fixture creates bare remotes and six real lane worktrees, runs actual Git
pushes and hooks, and compares six serial candidates with one combined train.
The hook sleeps 40 ms instead of running production checks.

A local run on 2026-10-20 measured 1,545 ms serial versus 1,019 ms batched,
with **six versus one hook invocations**. These fixture times measure queue and
Git overhead, not production gate speed.

Using the comparison report's 4.5-minute gate assumption, six already-waiting
green lanes take about **27 minutes serial versus 4.5 minutes batched**, plus
integration, per-commit scanning and polling overhead. Mean completion falls
from 15.75 to approximately 4.5 minutes; the last lane saves 22.5 minutes.
This is a modeled projection, not a measured production rollout. Failure
fallback costs one failed batch gate plus the halving runs described above.

## Waiting sessions

The lock records the running train's tickets, and every lock hold appends its
duration to `<git-common-dir>/push-queue-history.jsonl` (last 50 kept). A
waiting process prints its place, whether it is in the running train, and an
estimate from the median of the last ten holds; without history it prints no
estimate.
