---
"@tedix/cli": patch
---

On macOS, `tedix update` re-signs the installed binary with a self-signed code-signing identity named "Tedix CLI (local)" when you have created one, so a Full Disk Access grant for the background supervisor survives updates. Tedix never creates the identity. `tedix supervise install` points at the new guide until the binary is signed.
