---
"@tedix/cli": minor
---

`tedix learn onboard` now runs in the background and returns at once (`--wait` keeps it in the foreground; running it again resumes a run that stopped). Its proposals arrive in your Tedix inbox with the sessions they came from, and you can accept or decline them in Tedix OS, in chat or with `tedix learn review`. Accepting a proposal creates its Work, and a declined one is never asked again on any machine. A body of work with three or more tasks that no project or epic on the board covers is proposed as one epic with its tasks under it.
