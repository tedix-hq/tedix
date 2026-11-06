---
"@tedix/cli": patch
---

Keep each agent session's credential cached independently so parallel dispatcher lanes do not force one another to exchange credentials before every Work read.
