---
"@tedix/cli": patch
---

`tedix work complete` run as an external agent now explains when the agent may complete the item itself (an accepted item whose latest Attempt is its own, settled succeeded with `--commit`, and not credentials, payment or messaging work) before pointing to the owner login.
