---
"@tedix/cli": patch
---

`tedix work context` now shows the item's readiness, so a run waiting on an answer to its question is named with how to answer it. The Work Item's creator can now send that answer through `send_work_attempt_message` even when they are not its owner or steward.
