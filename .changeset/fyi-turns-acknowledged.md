---
"@tedix/cli": patch
---

A turn end whose message asks the user for nothing is now closed by the server as acknowledged (`request_agent_reply_draft` answers `acknowledged`) instead of waiting for a tedi-drafted "carry on". The `await-reply` hook stops waiting on such a question without waking the session, and a closure recorded with no delivery is never read back as the user's answer.
