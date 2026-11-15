---
"@tedix/cli": patch
---

Tedix now accepts a Work Item only when it has a project, a done-when and an accountable owner, and says what is missing otherwise. `tedix lane serve --accept-proposed` leaves proposals without an accountable owner in triage instead of trying to accept them; file shift Work with `--owner`.
