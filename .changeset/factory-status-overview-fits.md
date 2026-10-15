---
"@tedix/cli": patch
---

`tedix factory status` without a slug no longer fails with "result truncated by gateway" when an organization has many factories; the overview now fetches only the fields it prints.
