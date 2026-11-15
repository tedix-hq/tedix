---
"@tedix/cli": patch
---

A runner no longer spends up to five minutes on every sweep measuring a run
folder that is too large to measure in time. One Work revision with 30
checkouts hit the five-minute limit on each try. A folder whose measurement
fails is now tried again after an hour, and its last known size is used until
then.
