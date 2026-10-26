---
"@tedix/cli": patch
---

`tedix skill` gains `find <query>`, `schedule <id|slug>` (cron, enabled, next and last fire) and `edit <id> --file SKILL.md --file scripts/workflow.ts`; `skill list` reads long lists page by page instead of hitting the gateway result cap, and `skill inspect` lists a run's steps failed-first without step output. `tedix work create` accepts `--description` and `--owner <user|tedi|team|system>:<id>`.
