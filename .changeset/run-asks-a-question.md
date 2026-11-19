---
"@tedix/cli": minor
---

An agent run can ask the person who owns its task a question and wait for the answer. The agent ends its turn with `outcome=question` (a short question and up to five offered answers); the runner shows it in the run's log, keeps the run alive for up to 30 minutes, and gives the agent the person's answer as its next turn on the same session. With no answer in time the run ends as deferred with the question in its note and the task stays open. A question that asks for a password, key, code, sign-in or consent is not passed on.
