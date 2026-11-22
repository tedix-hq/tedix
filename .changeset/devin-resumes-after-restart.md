---
"@tedix/cli": patch
---

Devin runner tasks now continue after the Tedix app quits or restarts, like Codex, Claude Code and OpenCode tasks: the next runner resumes the same Devin session in the same checkout under the same Attempt. Before, a running Devin task was left until its lease ran out, ended `expired`, and after two such ends the Work was held with its result unrecorded.
