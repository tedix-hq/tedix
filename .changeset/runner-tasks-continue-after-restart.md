---
"@tedix/cli": minor
---

Runner tasks continue where they stopped after the Tedix app quits or restarts. When a runner starts and finds a task its previous runner left mid-turn, with the task's Attempt still open, it resumes the same Codex, Claude Code or OpenCode session in the same checkout under the same Attempt, with a short note that the app restarted. Only when the session or checkout is gone does the Attempt end and the task start again, and the runner log says why (`restart-resume-fallback`).
