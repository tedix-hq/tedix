---
"@tedix/cli": patch
---

A follow-up or a stop sent to a run is no longer lost when the server's answer does not arrive or the runner restarts. The runner passes each message to the agent once even when the server returns it again, reports a follow-up as applied only after its turn has started, reports a stop as applied after the agent has ended, and picks up unapplied follow-ups when it resumes an interrupted run.
