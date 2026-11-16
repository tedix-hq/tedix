---
"@tedix/cli": patch
---

Background runners (`tedix lane serve`) accept a new result, `landed_unverified`, for a change that is on main but whose result the agent could not confirm (a failed check, or a deploy or production it cannot read). The run counts as succeeded with its commits and the task is not started again. The runner records a hold on the task and sends its owner one request to check the result; the owner completes the task, or edits it to have an agent work on it again. Before, agents reported such a run as a wait and the runner ran the task again every six hours.
