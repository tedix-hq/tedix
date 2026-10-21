---
"@tedix/cli": patch
---

Prevent shared login family revocation by recording refresh attempts before sending them and refusing to replay a token after an uncertain result. Successful rotations clear the marker when saved; interrupted requests, process death, invalid replies and failed saves require reauthentication instead of risking token reuse. Reject stale provider metadata saves that would restore a superseded token. Renewal diagnostics also record the attempt start time.
