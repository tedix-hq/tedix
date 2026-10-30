---
"@tedix/cli": patch
---

Confirm the saved access token after an uncertain renewal without replaying a possibly rotated refresh token. Adopt a newer saved login, preserve the original failure journal, and pause local lanes with one sign-in Decision when access is rejected. Do not mark an already-aborted refresh request as sent.
