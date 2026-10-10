---
"@tedix/cli": patch
---

An auto-delivered tedi reply now answers its question on the server in the tedi's name: the `await-reply`, `await-draft` and `supervise` deliveries call the new `work interaction-draft-delivered` (`record_reply_draft_delivery`) once per draft, so the question leaves the user's "For you" inbox while the user's later reply, typed in the chat or in Tedix OS, is still recorded and delivered as a correction.
