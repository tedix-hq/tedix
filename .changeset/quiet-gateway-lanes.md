---
"@tedix/cli": patch
---

Reduce gateway traffic with a five-minute Work descriptor cache scoped to the profile and organization, in-process lane telemetry every 120 seconds or on state change, and a shared Retry-After cooldown across local CLI processes. Mutation authorization and current-state checks remain server-side; schema failures invalidate discovery without replaying a write.
