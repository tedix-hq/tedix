---
"@tedix/cli": patch
---

Wait and resend a tool call, at most twice, when the gateway refuses it because the organization's autonomous action policy could not be read right now. The gateway now marks this refusal as typed and says that nothing ran, so resending is safe; every other tool error is still returned at once. Each wait honours the refusal's `Retry-After` plus a random share of it and never runs past the call's deadline.
