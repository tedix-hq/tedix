---
"@tedix/cli": patch
---

Wait out a gateway rate limit instead of failing. When the gateway refuses a request with HTTP 429 and `Retry-After`, the CLI resends it up to twice after the advertised wait plus jitter, within the command's deadline. The refusal happens before any tool runs, so `work accept`, `work complete` and other writes retry safely.
