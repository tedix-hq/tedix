---
"@tedix/cli": patch
---

Agent-session hooks call Tedix far less often. Sessions on one computer share the approved-lesson list for a few minutes instead of fetching it on every prompt or every 30 seconds, look-only shell commands such as `ls` or `git status` never fetch it themselves, nothing is fetched while Tedix asks clients to slow down, and session status is refreshed every two minutes instead of every minute. Lessons still appear when you run a matching command or edit a matching file; a newly approved lesson can take up to five minutes to appear.
