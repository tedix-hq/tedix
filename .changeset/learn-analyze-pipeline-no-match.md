---
"@tedix/cli": patch
---

Session analysis no longer counts a pipeline that ends in a search finding nothing (for example `ls | grep x`) as a failing tool call.
