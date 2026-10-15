---
"@tedix/cli": minor
---

New `tedix channel codex <thread-id>`: poll Tedix events and deliver each batch to a Codex thread through `codex queue`, resuming the thread headless when no Codex window takes it. Channel notices now point at `tedix work context <id>`.
