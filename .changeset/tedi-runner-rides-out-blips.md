---
"@tedix/cli": patch
---

A tedi runner task no longer fails when one gateway call is refused for a moment, such as a brief database overload: the call is tried again a few times first.
