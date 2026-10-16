---
"@tedix/cli": minor
---

Add `tedix learn profile`, which `tedix learn onboard` now runs second. It reads every local Claude Code and Codex transcript in full, including sub-agent runs, supervisor Work runs and very large rollouts. Your local model summarises each session, then each body of work, then you. The result is "What Tedix knows about you", a document in your own Tedix space covering your active projects linked to the board, open loops, workflows Tedix could take over, the people you work with, how you work, and three things Tedix can do for you now, each also sent as an inbox proposal. Summaries are cached, so a re-run reads only new sessions, and transcripts never leave your machine.
