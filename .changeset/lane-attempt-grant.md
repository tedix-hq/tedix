---
"@tedix/cli": patch
---

Owners can now give a job one more try with `tedix work attempt-grant <id> --input '{"attemptId":"<failed attempt>","reason":"<why>"}'`. The grant names the failed or timed-out try it replaces, records who approved it and why, and works only once per try. Agent sessions cannot grant tries. Paused runs (deferred or waiting for a person) no longer use up a job's tries.
