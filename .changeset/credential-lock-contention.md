---
"@tedix/cli": patch
---

Avoid excessive credential write delays under concurrent CLI processes by using shorter waits between lock checks.
