---
"@tedix/cli": patch
---

A follow-up, a "Send now" message or an answer to a run's question no longer fails the run when it starts its turn. Each turn of a run now writes to its own output files, also after the runner restarts, and earlier turns' files are kept. If a follow-up turn still cannot start on the machine, the run ends with the result of the turn before it, the run's log says the follow-up was not applied, and the message stays unapplied.
