---
"@tedix/cli": patch
---

Use the requested agent harness's native session ID during agent bootstrap, preserving explicit session overrides and refusing mismatched or missing identities before credential exchange. A Codex worker launched from Claude no longer registers under the launcher's Claude session.
