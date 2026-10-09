---
"@tedix/cli": patch
---

Local agent status treats a session with no update for 12 hours as ended, and `tedix hooks status` and `tedix supervise` remove session status files untouched for 7 days.
