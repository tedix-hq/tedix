---
"@tedix/cli": minor
---

Add `tedix factory create --goal "..." --owner <tedi>` to build a factory in one call: a Work project and objective, a daily scheduled lane skill from the `report` template, and a standing health Work Item. Re-running it with the same slug changes nothing. Add `tedix factory status [<slug>]`, which gives each factory one verdict (healthy, idle, failing, not_firing or pending) with its recent runs and what each delivered.
