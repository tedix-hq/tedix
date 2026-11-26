---
"@tedix/cli": patch
---

Measure retained run checkouts by allocated disk blocks, like `tedix storage`, so APFS clone families are not counted once per run folder; a runner that cannot get under its checkout cap now reports the held reason in its health instead of appearing stuck.
