---
"@tedix/cli": patch
---

`work interaction-respond --no-deliver` closes a status update without delivering the answer to the asking session or handing it off (response `metadata.delivery: "none"`); the Office shows it as "Closed (no delivery)".
