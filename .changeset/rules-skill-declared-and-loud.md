---
"@tedix/cli": patch
---

`tedix lane serve` now tells Tedix which skill it reads as its rules, so the skill shows its runners under "Used by" and cannot be archived by mistake. When that skill is not active, the runner says so in the supervisor log and in its health report ("rules skill lane-rules is archived: no work will be admitted until it is restored") instead of failing each task quietly. `tedix skill show` lists what uses a skill.
