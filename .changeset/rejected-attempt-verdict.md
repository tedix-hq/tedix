---
"@tedix/cli": patch
---

`tedix work settle` accepts `--outcome rejected` for a run that finished and declared the accepted outcome incomplete. The server never reruns a rejected Attempt on the same Work revision, while crashes (`failed`, `expired`) still retry within the lane policy's `maxAttempts`. The local dispatcher no longer holds Work on its own count of failed Attempts.
