---
"@tedix/cli": patch
---

Removing Tedix from an agent ends that install's server grant and refresh token before clearing its local sign-in. Other installs keep their shared consent and stay signed in. If the server cannot confirm removal, the local connection stays available to retry.
