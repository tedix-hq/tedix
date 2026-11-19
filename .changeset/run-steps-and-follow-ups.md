---
"@tedix/cli": minor
---

A runner now keeps a log of each Codex or Claude run and lets people steer it. While an agent works on a task, the runner sends short steps to Tedix every 5 seconds: what the agent said, which commands and tools it ran, and which files it changed, with secrets masked and no command output or file contents. A follow-up sent to the run is passed to the agent as a further turn in the same session once the current turn ends, up to five per run, and the result of the last turn is the one recorded. A follow-up that asks for a human-reserved action is passed on only when the task's accountable owner sent it; consent, MFA and sign-in steps are never passed on. A stop request ends the agent, records the run as cancelled with a note naming who stopped it, and the runner does not start that version of the task again. A runner connected to a server without the step tool logs that once and runs as before.
