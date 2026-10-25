---
"@tedix/cli": patch
---

`lane serve` no longer fails an admitted Attempt when the lane's first observation report times out ("Work native command deadline exceeded"); the child launches and the next heartbeat reports it.
