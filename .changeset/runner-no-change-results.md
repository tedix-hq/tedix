---
"@tedix/cli": minor
---

A runner no longer fails and repeats a run that found its task already done. A result can name the earlier commits on main in `existingCommits`; the runner checks them and records the run as succeeded. A passing network or server fault while a Devin result is saved is retried and no longer starts the session again.
