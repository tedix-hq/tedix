---
"@tedix/cli": patch
---

Keep each task's saved deferral reason and first retry deadline across runner restarts. Do not rerun a landed, unverified result for the same Work version, including when its commit proof was rejected.
