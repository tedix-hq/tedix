---
"@tedix/cli": patch
---

Agent hooks now read, acknowledge and record Tedix OS answers and drafts through Code Mode, which takes about 2 s instead of 5 to 14 s. Acknowledgements fit their 3-second hook budget, so a delivered answer no longer stays listed as undelivered.
