---
"@tedix/cli": patch
---

`agent start` no longer hands a Claude Code, Codex, Devin, OpenCode or Cursor session a principal named for a different harness. A workspace whose principal was bootstrapped for one harness (such as `codex-…`) now bootstraps a separate `<harness>-local-<user>-<machine>` principal for each other harness, so their work is attributed to their own identity. Sessions already started keep their principal.

First-time `agent start` bootstrap finds the organization list again; the gateway now returns tool provenance only with `includeMetadata`.
