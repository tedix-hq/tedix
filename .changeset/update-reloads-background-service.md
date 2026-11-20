---
"@tedix/cli": patch
---

`tedix update` and `tedix rollback` now reload the background service on macOS when it runs the file they replaced, and say whether it came back. Before, macOS refused to start the service again after an update until it was unloaded and loaded by hand. Runs in progress stop when the service reloads. The copy that comes with the Tedix app can now be updated and rolled back with these commands too.
