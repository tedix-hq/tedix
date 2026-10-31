---
"@tedix/cli": patch
---

Run lane dispatchers as children of the supervisor: `tedix lane serve --install` records a duty in `~/.tedix/supervisor-lanes.json` instead of creating a LaunchAgent, the supervisor starts, restarts and stops them, `tedix supervise install` adopts dispatchers installed as their own LaunchAgents, and `tedix supervise lanes` lists them.
