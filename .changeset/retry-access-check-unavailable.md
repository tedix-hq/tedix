---
"@tedix/cli": patch
---

Wait and retry, at most twice, when the gateway answers 503 because it could not check access right now (`human_mcp_grant_unavailable` or `external_agent_validation_unavailable`). The gateway refuses these before running any tool, so resending is safe. Each wait honours `Retry-After` plus a random share of it, so many agents refused together do not come back together. Agent session start also backs off up to three times with jitter when the session backend reports it is busy.
