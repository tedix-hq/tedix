---
"@tedix/cli": patch
---

Honor `--executor` on `work create` and `work accept`, so delegated Work carries its executor assignment and can enter the dispatch queue. Reject unknown executor names before making requests. Acceptance stops if assignment fails and reports retained assignment if acceptance fails afterwards.
