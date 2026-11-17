---
"@tedix/cli": patch
---

Work tools gain two owner/admin undo operations: `restore_work_filing` puts a Work Item's project, objective, class and exception expiry back exactly (nulls included), and `detach_work_case_item` removes an epic attachment without touching the Work.
