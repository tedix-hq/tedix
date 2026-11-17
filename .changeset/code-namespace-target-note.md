---
"@tedix/cli": patch
---

`tedix code` explains a namespace that is undefined because the call ran for a different target: a call for one organization uses that organization's own names (`work.*`), a Connect call without an organization uses `<organization>_unified_<app>`. `tedix code --help` states the rule, and `tedix work --help` says who answers for Work created without `--owner`.
