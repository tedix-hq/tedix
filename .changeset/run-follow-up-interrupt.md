---
"@tedix/cli": minor
---

A follow-up sent to a run with "Send now" (or `interrupt` on `send_work_attempt_message`) no longer waits for the agent's current turn to end. The runner stops the turn of a Codex or Claude Code run and starts the next turn on the same session with the follow-up; other agents, and a turn that does not stop in time, take the follow-up when the turn ends, and the run's log says so.
