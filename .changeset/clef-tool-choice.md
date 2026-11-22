---
"@tedix/cli": minor
---

Clef can pick the coding tool for each task. With `"decide": "clef"` (the default) and tool strengths in the routing file, runners ask Clef once per task revision which available tool fits best, write the pick and confidence on the task, and move it when the pick differs. When Clef is slow, unsure or unavailable the routing rules decide and the task says so. `tedix lane routing` shows who decides.
