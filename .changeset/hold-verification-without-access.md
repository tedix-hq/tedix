---
"@tedix/cli": patch
---

Stop re-running agent verification of a landed change when the verifier cannot reach what proves it, such as a browser, computer use or a missing scope. The runner records the run as cancelled instead of failed, holds the task, and asks its owner once what someone with access must check.
