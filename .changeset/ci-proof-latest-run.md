---
"@tedix/cli": patch
---

Already-satisfied CI proofs accept a run named "<workflow> @ <sha>" and a newer successful run of the same workflow that contains it, such as the push Deploy gate after a dispatched full run. The accepted outcome must still name the workflow and minimum commit.
