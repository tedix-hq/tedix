---
"@tedix/cli": patch
---

`tedix hooks prompt-context` now finishes in a few seconds instead of timing out: its gateway, organization and answer reads run in parallel, the working-preferences document, team lessons and organization check are cached for ten minutes under `~/.tedix/hook-cache/`, and each read fails on its own. `TEDIX_HOOK_TRACE=1` prints per-step timings.
