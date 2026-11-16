---
"@tedix/cli": patch
---

Background runners (`tedix lane serve`) land finished work sooner, keep their task startable while they check a result, and no longer crash on a run that declared no result.

- The brief now tells the agent how to land a change: run the type-check and the focused tests of what it changed, then push with the repository's own push command (`bun run push` where the repository has one). It says not to run a whole workspace's or the whole repository's test suite locally unless the task asks for it. If the push is refused, the agent copies the one-sentence reason to the task and ends the run. Before, runs waited on full local suites until their time ran out and never pushed.
- When a run ends with commits that are not on main, the result recorded on the task starts with how many, which ones, where they are kept and the reason the run gave. Later holds on the task and the next run's brief repeat that reason.
- The runner keeps renewing a run's lease while it checks the result. Before, the renewal stopped when the agent finished, and a slow check could pass half the lease. Tedix then recorded the run as stopped and took the task off the list runners read.
- A run that cited an earlier commit without declaring a result ended with `TypeError: undefined is not an object (evaluating 't.workItemId')`, three times in a row, and the task was held. Such a run is now checked like any other: an earlier commit of the same task counts when its original run vouches for it, and otherwise the task says that no result was declared.
- If the runner itself fails while checking a result, the note says so and keeps what the agent reported.
