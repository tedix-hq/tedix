---
"@tedix/cli": patch
---

The tool decision's threshold now uses how likely the model rates its pick among the offered tools (default 35%), since its separate confidence figure stays near 0.1 even for clear picks. A tool at or below the routing file's near-limit allowance is not offered to the decision model.
