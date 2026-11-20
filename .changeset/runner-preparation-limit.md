---
"@tedix/cli": patch
---

A runner now prepares at most three Work Items for admission at once and starts the next as each is admitted or fails, instead of starting every ready item in one go; on a slow gateway that left dozens of start-ups timing out with nothing admitted. The number of runs that may be running is not limited. The rules are read once per pass instead of once per start.
