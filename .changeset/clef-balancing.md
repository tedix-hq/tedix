---
"@tedix/cli": minor
---

The tool decision now balances work. Runners send the decision model each available tool's strengths, example tasks, runs in progress, starts waiting, allowance left and its results over the last 14 days, skip a tool at its `maxRunning` cap, and write the deciding facts on the task ("Codex is running 9 tasks, Claude Code 3; Claude Code finished 134 of 222 tasks in 14 days"). `decideModel` in the routing file chooses Clef or Jev.
