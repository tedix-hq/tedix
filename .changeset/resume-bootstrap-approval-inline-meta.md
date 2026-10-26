---
"@tedix/cli": patch
---

`tedix agent start` now sends the decided owner-approval id inside the `create_api_key` arguments, the shape Code Mode reads, so a resumed bootstrap consumes the approved request instead of opening a new one on every start.
