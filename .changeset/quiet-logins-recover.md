---
"@tedix/cli": patch
---

Allow a slow login renewal up to a minute and retry once when no connection opened. Keep uncertain refresh tokens fenced, and notify the owner once from the supervisor when a shared runner login cannot renew safely, even if the gateway is unavailable.
