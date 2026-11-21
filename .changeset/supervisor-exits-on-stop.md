---
"@tedix/cli": patch
---

`tedix supervise` ends at once when it is asked to stop. A stop that arrived during its check of waiting questions was only obeyed after that check, which can take minutes, so the Tedix app had to stop it by force after 30 seconds on quit and on updates.
