---
"@tedix/cli": patch
---

Lane dispatchers and the Lead supervisor briefly retry process identity capture after spawning, so Linux runs remain recoverable when `/proc` has not exposed the child's command line yet.
