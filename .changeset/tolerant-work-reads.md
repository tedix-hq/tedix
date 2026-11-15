---
"@tedix/cli": patch
---

Work, Deck and Feed reads no longer fail when Tedix Cloud returns a field this CLI version does not know yet. The CLI ignores the new field and still checks every field it reads, so `tedix work list`, `checkpoint`, `attempts`, `evidence`, `events`, the interaction inbox, agent-turn triage and background runners (`tedix lane serve`) keep working between CLI releases. If the server stops sending a field the CLI needs, or changes its type, the error now names that field and suggests running `tedix update`.
