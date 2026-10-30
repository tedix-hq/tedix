---
"@tedix/cli": patch
---

Recognize dispatcher-created Codex sessions as unattended when resumed through exec, so finished tasks do not wait for an interactive Stop draft. Ordinary interactive sessions keep their existing reply and approval behavior.
