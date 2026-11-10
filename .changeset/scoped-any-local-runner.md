---
"@tedix/cli": patch
---

Let a project- or repo-scoped `lane serve --executor any-local` run beside the per-executor runners: it locks and reports under its own dispatcher scope instead of waiting on every executor lock, so the supervisor no longer kills it for a missed pass.
