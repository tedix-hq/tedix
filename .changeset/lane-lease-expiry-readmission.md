---
"@tedix/cli": patch
---

A Work Item whose Attempt lease elapsed while its result was retained is now re-admitted automatically on the same Work revision, instead of waiting for someone to bump the version. An elapsed lease counts as an interruption, not an execution failure, so it no longer feeds the three-strike execution hold.
