---
"@tedix/cli": patch
---

`tedix agent start` now prints one line when a profile still carries the name of the agent that first set it up, with the exact `tedix agent rename` command to name it for this machine. It stays quiet once the name is the machine's or one the owner chose.
