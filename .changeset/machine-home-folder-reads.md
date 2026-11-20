---
"@tedix/cli": patch
---

A machine whose owner switched the write tools on now lets a tedi list a folder and read a text file under the owner's home folder, such as `~/Downloads`, for a signed-in person. Credential locations, hidden settings folders, app data and anything outside the home folder are refused. A command no longer needs a workspace first: without one it runs in the home folder.
