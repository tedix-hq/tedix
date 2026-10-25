---
"@tedix/cli": patch
---

`tedix lane serve` briefs now give every lane its exact `Work-Item` and `Agent-Session` trailers and ask for them in one final paragraph, so lane commits pass the pre-push secret scan instead of being refused for trailers split by blank lines.
