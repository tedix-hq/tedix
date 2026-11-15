---
"@tedix/cli": patch
---

Let the dispatcher settle coding Work whose accepted delivery is an unpushed local branch. Set `metadata.artifactKind` to `local_branch` and `metadata.artifactLocalBranch` to `{branch, baseCommit}`; the dispatcher then verifies the declared commit, its ancestry and custody, the clean retained checkout and the Attempt's `test_report` evidence. Work without that setting still needs landed commits.
