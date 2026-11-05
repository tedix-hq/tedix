---
"@tedix/cli": patch
---

Local runners no longer fail Work that the owner edits while the runner is preparing it. The runner re-reads the Work just before starting and stops without creating an Attempt if it changed; the next poll starts the new revision. If an edit lands during the start call itself, the Attempt is settled as cancelled instead of failed, so it does not count toward the automatic execution hold.
