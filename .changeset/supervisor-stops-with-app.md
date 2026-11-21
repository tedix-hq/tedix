---
"@tedix/cli": patch
---

`tedix supervise` stops its runners as soon as it is asked to stop, instead of after the question check in progress. Started by the Tedix app, it also stops when the app is gone. On a Mac with the Tedix app, the app runs `tedix supervise` itself and removes the `tedix supervise install` login service.
