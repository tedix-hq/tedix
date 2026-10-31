---
"@tedix/cli": patch
---

The supervisor runs your runners. `tedix lane serve --install` records the runner in `~/.tedix/supervisor-runners.json` instead of creating its own background service; the supervisor starts, restarts and stops runners, `tedix supervise install` takes over runners installed as their own services, and `tedix supervise runners` lists them.
