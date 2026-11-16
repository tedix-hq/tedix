---
"@tedix/cli": patch
---

Epics have a new kind, `delivery`, for a feature or another result due by a date. Pass `"kind":"delivery"` to `tedix work case-create`; `tedix work --help` now lists every epic kind. Existing epics keep their kind.
