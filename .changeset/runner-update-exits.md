---
"@tedix/cli": patch
---

A runner leaving for an updated CLI now actually exits. It used to log that it was restarting and then stay alive, taking no Work, until the supervisor killed it as hung several minutes later.
