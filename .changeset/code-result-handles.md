---
"@tedix/cli": patch
---

`tedix code` and the Home reads behind `tedix status`, `tedix tail` and the transcript commands now read a large gateway result in full. When a Code Mode result is over the gateway's token budget, the gateway keeps the whole value for 30 minutes and returns a handle; the CLI pages it back through `discover.read_result` instead of shrinking the page or failing. A result the gateway could not keep still reports `truncated` as before.
