---
"@tedix/cli": patch
---

A runner on macOS no longer freezes after a start that was not admitted. Checking whether a run's folder was still in use opened the working folder of every process on the Mac, and macOS can hold such an open forever (an app's private folder, Documents); the runner then went silent until the supervisor killed it, and its replacement froze the same way. The check now uses the path macOS reports without opening it. The supervisor also tells a runner that waits for an earlier runner apart from a hung one: it no longer restarts the waiting runner, and it stops the earlier runner once that has outlived its two-minute drain time. A Codex start-up that times out now has its process killed if it ignores the request to stop.
